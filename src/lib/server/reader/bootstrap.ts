import { GetObjectCommand } from '@aws-sdk/client-s3';
import { and, eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import {
  documentSettings,
  documents,
  userDocumentProgress,
  userPreferences,
} from '@openreader/database/schema';
import { resolveTtsLanguage } from '@openreader/tts/language';
import {
  resolveProviderDefaults,
  resolveTtsProviderModelPolicy,
} from '@openreader/tts/provider-policy';
import type { NextRequest } from 'next/server';
import { APP_CONFIG_DEFAULTS, type AppConfigValues } from '@/types/config';
import { DEFAULT_DOCUMENT_SETTINGS } from '@/types/document-settings';
import type { BaseDocument } from '@/types/documents';
import type { DocumentProgressRecord } from '@/types/user-state';
import type { ParsedPdfDocument } from '@/types/parsed-pdf';
import type {
  ReaderBootstrapProgress,
  ReaderBootstrapResult,
  ReaderPayload,
} from '@/types/reader-bootstrap';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { parseEpubProgressLocator } from '@/lib/shared/epub-progress';
import { parseReaderInitialPosition } from '@/lib/shared/reader-position';
import {
  assertAuthoritativePlaybackPlan,
  normalizePlaybackPlan,
} from '@/lib/shared/playback-plan';
import { listAdminProviders } from '@/lib/server/admin/providers';
import {
  ComputeWorkerClient,
  isComputeWorkerAvailable,
} from '@/lib/server/compute-worker/client';
import type { TtsPlaybackPlanResult } from '@/lib/server/compute-worker/protocol';
import {
  createOrReuseCurrentPdfParseOperation,
  resolveCurrentPdfParse,
} from '@/lib/server/pdf-parse/operation';
import { pdfParseSnapshotFromWorkerState } from '@/lib/server/pdf-parse/snapshot';
import {
  checkJobRate,
  getPdfLayoutRateConfig,
  recordJobEvent,
} from '@/lib/server/rate-limit/job-rate-limiter';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { getS3Config, getS3InternalClient } from '@/lib/server/storage/s3';
import {
  buildTtsPlaybackPlanningInput,
  toTtsPlaybackPlanRequest,
  type ParsedTtsPlaybackRequestBody,
} from '@/lib/server/tts/playback-request';
import { readTtsPlaybackPlanArtifact } from '@/lib/server/tts/playback-plans';
import {
  resolveSegmentDocumentScope,
  type ResolvedSegmentDocumentScope,
} from '@/lib/server/tts/segments-auth';
import {
  sanitizePreferencesPatch,
  type PreferenceNormalizationContext,
} from '@/lib/server/user/preferences-normalize';
import { nowTimestampMs } from '@/lib/shared/timestamps';

type DocumentRow = {
  id: string;
  userId: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  folderId: string | null;
  recentlyOpenedAt: number | null;
};

export type ReaderBootstrapResolution = {
  result: ReaderBootstrapResult;
  operationId?: string;
};

function storedRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toProgress(row: {
  documentId: string;
  readerType: string;
  location: string;
  progress: number | null;
  clientUpdatedAtMs: number;
  updatedAt: number | null;
} | undefined): DocumentProgressRecord | null {
  if (!row) return null;
  const base = {
    documentId: row.documentId,
    progress: row.progress == null ? null : Number(row.progress),
    clientUpdatedAtMs: Number(row.clientUpdatedAtMs),
    updatedAtMs: Number(row.updatedAt ?? 0),
  };
  if (row.readerType === 'epub') {
    const locator = parseEpubProgressLocator(row.location);
    return locator ? { ...base, readerType: 'epub', locator } : null;
  }
  if (row.readerType === 'pdf' || row.readerType === 'html') {
    return { ...base, readerType: row.readerType, location: row.location };
  }
  return null;
}

function pendingPdfProgress(
  status: 'pending' | 'running',
  progress: { phase: 'infer' | 'merge'; pagesParsed: number; totalPages: number } | null,
): ReaderBootstrapProgress {
  return {
    kind: 'pdf-parse',
    phase: status === 'pending' ? 'queued' : progress?.phase === 'merge' ? 'merging' : 'parsing',
    pagesParsed: Math.max(0, Number(progress?.pagesParsed ?? 0)),
    totalPages: Math.max(0, Number(progress?.totalPages ?? 0)),
  };
}

async function ensurePdfReady(
  documentId: string,
  scope: ResolvedSegmentDocumentScope,
): Promise<ReaderBootstrapResolution | { parsedDocument: ParsedPdfDocument }> {
  const input = {
    documentId,
    namespace: scope.testNamespace,
  };
  let resolved = await resolveCurrentPdfParse(input);
  if (!resolved.artifact && !resolved.operation) {
    const runtimeConfig = await getResolvedRuntimeConfig();
    const rateConfig = getPdfLayoutRateConfig(runtimeConfig);
    const decision = await checkJobRate(scope.userId, 'pdf_layout', rateConfig);
    if (!decision.allowed) {
      return {
        result: {
          status: 'error',
          message: 'PDF preparation is temporarily rate limited. Please try again shortly.',
          retryable: true,
        },
      };
    }
    const operation = await createOrReuseCurrentPdfParseOperation(input);
    await recordJobEvent(scope.userId, 'pdf_layout', operation.opId, rateConfig);
    resolved = { artifact: null, operation };
  }
  if (resolved.artifact) {
    try {
      const object = await getS3InternalClient().send(new GetObjectCommand({
        Bucket: getS3Config().bucket,
        Key: resolved.artifact.objectKey,
      }));
      const body = await object.Body?.transformToString();
      if (!body) throw new Error('Parsed PDF artifact is empty');
      const parsedDocument = JSON.parse(body) as ParsedPdfDocument;
      if (!Array.isArray(parsedDocument.pages)) {
        throw new Error('Parsed PDF artifact does not contain pages');
      }
      return { parsedDocument };
    } catch {
      return {
        result: {
          status: 'error',
          message: 'PDF preparation completed without a readable artifact.',
          retryable: true,
        },
      };
    }
  }
  const operation = resolved.operation;
  if (!operation) {
    return { result: { status: 'pending', progress: pendingPdfProgress('pending', null) } };
  }
  const snapshot = pdfParseSnapshotFromWorkerState(operation);
  if (snapshot.parseStatus === 'failed') {
    return {
      result: {
        status: 'error',
        message: snapshot.error || 'PDF structure could not be prepared.',
        retryable: true,
      },
    };
  }
  if (snapshot.parseStatus === 'ready') {
    return {
      result: {
        status: 'error',
        message: 'PDF preparation completed without a readable artifact.',
        retryable: true,
      },
    };
  }
  return {
    result: {
      status: 'pending',
      progress: pendingPdfProgress(
        snapshot.parseStatus === 'running' ? 'running' : 'pending',
        snapshot.parseProgress,
      ),
    },
    operationId: operation.opId,
  };
}

function preferenceContext(
  runtimeConfig: Awaited<ReturnType<typeof getResolvedRuntimeConfig>>,
  providers: Awaited<ReturnType<typeof listAdminProviders>>,
): PreferenceNormalizationContext {
  return {
    showAllProviderModels: runtimeConfig.showAllProviderModels,
    sharedProviders: providers.filter((provider) => provider.enabled).map((provider) => ({
      slug: provider.slug,
      providerType: provider.providerType,
      defaultModel: provider.defaultModel,
      defaultInstructions: provider.defaultInstructions,
    })),
  };
}

async function resolvePlan(
  documentId: string,
  scope: ResolvedSegmentDocumentScope,
  settings: ReturnType<typeof mergeDocumentSettings>,
  storedPreferences: unknown,
): Promise<ReaderBootstrapResolution | { plan: ReaderPayload['plan'] }> {
  if (!isComputeWorkerAvailable()) {
    return {
      result: {
        status: 'error',
        message: 'The compute worker required for reader playback is unavailable.',
        retryable: true,
      },
    };
  }
  const [runtimeConfig, providers] = await Promise.all([
    getResolvedRuntimeConfig(),
    listAdminProviders(),
  ]);
  const normalization = preferenceContext(runtimeConfig, providers);
  const patch = sanitizePreferencesPatch(
    storedRecord(storedPreferences),
    normalization,
    { fillMissingProvider: true },
  ).patch;
  const preferences: AppConfigValues = { ...APP_CONFIG_DEFAULTS, ...patch };
  const provider = resolveProviderDefaults({
    providerRef: preferences.providerRef,
    providerType: preferences.providerType,
    sharedProviders: normalization.sharedProviders,
    fallbackProviderRef: runtimeConfig.defaultTtsProvider,
  });
  const model = preferences.ttsModel || provider.defaultModel;
  const policy = resolveTtsProviderModelPolicy({
    providerRef: provider.providerRef,
    providerType: provider.providerType,
    model,
  });
  const voice = preferences.voice;
  const language = resolveTtsLanguage({
    configuredLanguage: settings.language || 'auto',
    voice,
  });
  const parsed: ParsedTtsPlaybackRequestBody = {
    documentId,
    settings: {
      providerRef: provider.providerRef,
      providerType: provider.providerType,
      ttsModel: model,
      voice,
      nativeSpeed: policy.supportsNativeModelSpeed ? preferences.voiceSpeed : 1,
      ...(policy.supportsInstructions && (preferences.ttsInstructions || provider.defaultInstructions)
        ? { ttsInstructions: preferences.ttsInstructions || provider.defaultInstructions }
        : {}),
      language,
    },
    startLocation: {},
    maxBlockLength: preferences.ttsSegmentMaxBlockLength,
    language,
    ...(scope.readerType === 'pdf'
      ? { skipBlockKinds: settings.pdf?.skipBlockKinds ?? [] }
      : {}),
  };
  const planningInput = await buildTtsPlaybackPlanningInput(parsed, scope);
  const operation = await new ComputeWorkerClient().createTtsPlaybackPlanOperation(
    toTtsPlaybackPlanRequest({
      parsed,
      scope,
      ...planningInput,
      planning: planningInput.planning,
    }),
  );
  if (operation.status === 'queued' || operation.status === 'running') {
    return { result: { status: 'pending' }, operationId: operation.opId };
  }
  if (operation.status === 'failed') {
    return {
      result: {
        status: 'error',
        message: operation.error?.message || 'The reading plan could not be prepared.',
        retryable: true,
      },
    };
  }
  const result = operation.result as TtsPlaybackPlanResult | undefined;
  if (!result?.planObjectKey) {
    return {
      result: {
        status: 'error',
        message: 'The reading plan completed without an artifact.',
        retryable: true,
      },
    };
  }
  const { artifact, body } = await readTtsPlaybackPlanArtifact(result.planObjectKey);
  if (artifact.storageUserId && artifact.storageUserId !== scope.storageUserId) {
    return {
      result: {
        status: 'error',
        message: 'Reading plan scope mismatch.',
        retryable: false,
      },
    };
  }
  return {
    plan: assertAuthoritativePlaybackPlan(normalizePlaybackPlan({
      ...JSON.parse(body) as Record<string, unknown>,
      planId: operation.opId,
      planObjectKey: result.planObjectKey,
      planSignature: result.planSignature,
      startOrdinal: result.startOrdinal,
      plannedCount: result.plannedCount,
    }), { documentId, readerType: scope.readerType }),
  };
}

export async function resolveReaderBootstrapState(
  request: NextRequest,
  documentId: string,
): Promise<ReaderBootstrapResolution | Response> {
  const scope = await resolveSegmentDocumentScope(request, documentId);
  if (scope instanceof Response) return scope;
  let parsedPdfDocument: ParsedPdfDocument | null = null;
  if (scope.readerType === 'pdf') {
    const pdfState = await ensurePdfReady(documentId, scope);
    if ('result' in pdfState) return pdfState;
    parsedPdfDocument = pdfState.parsedDocument;
  }

  const [documentRows, settingsRows, progressRows, preferenceRows] = await Promise.all([
    db.select().from(documents).where(and(
      eq(documents.id, documentId),
      eq(documents.userId, scope.storageUserId),
    )).limit(1),
    db.select({ dataJson: documentSettings.dataJson }).from(documentSettings).where(and(
      eq(documentSettings.documentId, documentId),
      eq(documentSettings.userId, scope.storageUserId),
    )).limit(1),
    db.select({
      documentId: userDocumentProgress.documentId,
      readerType: userDocumentProgress.readerType,
      location: userDocumentProgress.location,
      progress: userDocumentProgress.progress,
      clientUpdatedAtMs: userDocumentProgress.clientUpdatedAtMs,
      updatedAt: userDocumentProgress.updatedAt,
    }).from(userDocumentProgress).where(and(
      eq(userDocumentProgress.documentId, documentId),
      eq(userDocumentProgress.userId, scope.storageUserId),
    )).limit(1),
    db.select({ dataJson: userPreferences.dataJson }).from(userPreferences)
      .where(eq(userPreferences.userId, scope.userId)).limit(1),
  ]);
  const row = documentRows[0] as DocumentRow | undefined;
  if (!row) return Response.json({ error: 'Document not found' }, { status: 404 });
  if (row.type !== 'pdf' && row.type !== 'epub' && row.type !== 'html') {
    return {
      result: {
        status: 'error',
        message: `Document type "${row.type}" does not have a reader.`,
        retryable: false,
      },
    };
  }
  const settings = mergeDocumentSettings(
    DEFAULT_DOCUMENT_SETTINGS,
    storedRecord(settingsRows[0]?.dataJson),
  );
  const progress = toProgress(progressRows[0]);
  const planResult = await resolvePlan(documentId, scope, settings, preferenceRows[0]?.dataJson);
  if ('result' in planResult) return planResult;

  const document: BaseDocument = {
    id: row.id,
    name: row.name,
    type: row.type,
    size: Number(row.size),
    lastModified: Number(row.lastModified),
    recentlyOpenedAt: row.recentlyOpenedAt == null ? undefined : Number(row.recentlyOpenedAt),
    contentVersion: row.id,
    scope: 'user',
    folderId: row.folderId ?? undefined,
  };
  await db.update(documents).set({ recentlyOpenedAt: nowTimestampMs() }).where(and(
    eq(documents.id, documentId),
    eq(documents.userId, scope.storageUserId),
  ));
  let payload: ReaderPayload;
  if (row.type === 'pdf') {
    if (!parsedPdfDocument) {
      return {
        result: {
          status: 'error',
          message: 'PDF preparation completed without a readable artifact.',
          retryable: true,
        },
      };
    }
    payload = {
      documentId,
      readerType: 'pdf',
      document: { ...document, type: 'pdf' },
      settings,
      plan: planResult.plan,
      initialPosition: parseReaderInitialPosition('pdf', progress),
      parsedDocument: parsedPdfDocument,
    };
  } else if (row.type === 'epub') {
    payload = {
      documentId,
      readerType: 'epub',
      document: { ...document, type: 'epub' },
      settings,
      plan: planResult.plan,
      initialPosition: parseReaderInitialPosition('epub', progress),
    };
  } else {
    payload = {
      documentId,
      readerType: 'html',
      document: { ...document, type: 'html' },
      settings,
      plan: planResult.plan,
      initialPosition: parseReaderInitialPosition('html', progress),
    };
  }
  return {
    result: {
      status: 'ready',
      payload,
    },
  };
}

export async function resolveReaderBootstrap(
  request: NextRequest,
  documentId: string,
): Promise<ReaderBootstrapResult | Response> {
  const resolution = await resolveReaderBootstrapState(request, documentId);
  return resolution instanceof Response ? resolution : resolution.result;
}

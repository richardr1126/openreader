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
import type { ParsedPdfDocument } from '@/types/parsed-pdf';
import type {
  ReaderBootstrapResult,
  ReaderPayload,
} from '@/types/reader-bootstrap';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import type { ReadingPosition } from '@/lib/shared/reading-position';
import {
  assertAuthoritativePlaybackPlan,
  normalizePlaybackPlan,
} from '@/lib/shared/playback-plan';
import { listAdminProviders } from '@/lib/server/admin/providers';
import {
  ComputeWorkerClient,
  isComputeWorkerAvailable,
} from '@/lib/server/compute-worker/client';
import type {
  TtsPlaybackPlanResult,
} from '@/lib/server/compute-worker/protocol';
import {
  createOrReuseCurrentPdfParseOperation,
  fetchPdfParseOperation,
  isPdfParseOperationForDocument,
  resolveCurrentPdfParse,
} from '@/lib/server/pdf-parse/operation';
import {
  isCurrentPdfParseOperationAuthoritative,
} from '@/lib/server/pdf-parse/snapshot';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import {
  ComputeAdmissionLimitedError,
  createAdmittedComputeOperation,
} from '@/lib/server/compute-limits/run-admitted';
import { getClientIp } from '@/lib/server/rate-limit/request-ip';
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
import { toBaseDocument, type StoredDocumentRow } from '@/lib/server/documents/document-row';
import { resolvePdfOperationReadiness } from './bootstrap-progress';

type DocumentRow = StoredDocumentRow & { userId: string };

export type ReaderBootstrapResolution = {
  result: ReaderBootstrapResult;
  operationId?: string;
};

export type ReaderBootstrapResolveOptions = {
  preparationOperationId?: string | null;
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

function toReadingPosition(row: {
  segmentKey: string | null;
  segmentOrdinal: number;
} | undefined): ReadingPosition | null {
  if (!row) return null;
  return {
    segmentKey: row.segmentKey ?? null,
    segmentOrdinal: Math.max(0, Number(row.segmentOrdinal ?? 0)),
  };
}

async function ensurePdfReady(
  request: NextRequest,
  documentId: string,
  scope: ResolvedSegmentDocumentScope,
  options: ReaderBootstrapResolveOptions,
): Promise<ReaderBootstrapResolution | { parsedDocument: ParsedPdfDocument }> {
  const input = {
    documentId,
    namespace: null,
  };
  const requestedOperationId = options.preparationOperationId?.trim();
  if (requestedOperationId) {
    const requestedOperation = await fetchPdfParseOperation(requestedOperationId);
    if (
      !requestedOperation
      || !isPdfParseOperationForDocument(requestedOperation, input)
    ) {
      return {
        result: {
          status: 'error',
          message: 'The requested PDF reparse operation is unavailable.',
          retryable: false,
        },
      };
    }
    const requestedReadiness = resolvePdfOperationReadiness(requestedOperation);
    if (requestedReadiness) return requestedReadiness;
  }
  let resolved = await resolveCurrentPdfParse(input);
  if (!resolved.artifact && !resolved.operation) {
    const runtimeConfig = await getResolvedRuntimeConfig();
    try {
      const operation = await createAdmittedComputeOperation({
        policy: runtimeConfig.computeLimitPolicies,
        action: 'pdf_layout',
        requestKey: `${documentId}:${scope.documentVersion}:current`,
        subject: {
          userId: scope.userId,
          isAnonymous: scope.isAnonymousUser,
          ip: getClientIp(request),
        },
        create: () => createOrReuseCurrentPdfParseOperation(input),
      });
      resolved = { artifact: null, operation };
    } catch (error) {
      if (!(error instanceof ComputeAdmissionLimitedError)) throw error;
      return {
        result: {
          status: 'error',
          message: 'PDF preparation is temporarily rate limited. Please try again shortly.',
          retryable: true,
        },
      };
    }
  }
  const currentOperation = resolved.operation;
  if (currentOperation && isCurrentPdfParseOperationAuthoritative(resolved)) {
    const readiness = resolvePdfOperationReadiness(currentOperation);
    if (readiness) return readiness;
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
  return {
    result: {
      status: 'error',
      message: 'PDF preparation completed without a readable artifact.',
      retryable: true,
    },
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
  request: NextRequest,
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
  let operation;
  try {
    operation = await createAdmittedComputeOperation({
      policy: runtimeConfig.computeLimitPolicies,
      action: 'tts_playback_plan',
      requestKey: `${documentId}:${scope.documentVersion}:${planningInput.settingsHash}`,
      subject: {
        userId: scope.userId,
        isAnonymous: scope.isAnonymousUser,
        ip: getClientIp(request),
      },
      create: () => new ComputeWorkerClient().createTtsPlaybackPlanOperation(
        toTtsPlaybackPlanRequest({
          parsed,
          scope,
          ...planningInput,
          planning: planningInput.planning,
        }),
      ),
    });
  } catch (error) {
    if (!(error instanceof ComputeAdmissionLimitedError)) throw error;
    return {
      result: {
        status: 'error',
        message: error.message,
        retryable: true,
      },
    };
  }
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
  options: ReaderBootstrapResolveOptions = {},
): Promise<ReaderBootstrapResolution | Response> {
  const scope = await resolveSegmentDocumentScope(request, documentId);
  if (scope instanceof Response) return scope;
  if (options.preparationOperationId && scope.readerType !== 'pdf') {
    return {
      result: {
        status: 'error',
        message: 'The requested preparation operation does not apply to this reader.',
        retryable: false,
      },
    };
  }
  let parsedPdfDocument: ParsedPdfDocument | null = null;
  if (scope.readerType === 'pdf') {
    const pdfState = await ensurePdfReady(request, documentId, scope, options);
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
      segmentKey: userDocumentProgress.segmentKey,
      segmentOrdinal: userDocumentProgress.segmentOrdinal,
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
  const initialPosition = toReadingPosition(progressRows[0]);
  const planResult = await resolvePlan(request, documentId, scope, settings, preferenceRows[0]?.dataJson);
  if ('result' in planResult) return planResult;

  const document: BaseDocument = toBaseDocument(row);
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
      initialPosition,
      parsedDocument: parsedPdfDocument,
    };
  } else if (row.type === 'epub') {
    payload = {
      documentId,
      readerType: 'epub',
      document: { ...document, type: 'epub' },
      settings,
      plan: planResult.plan,
      initialPosition,
    };
  } else {
    payload = {
      documentId,
      readerType: 'html',
      document: { ...document, type: 'html' },
      settings,
      plan: planResult.plan,
      initialPosition,
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
  options: ReaderBootstrapResolveOptions = {},
): Promise<ReaderBootstrapResult | Response> {
  const resolution = await resolveReaderBootstrapState(request, documentId, options);
  return resolution instanceof Response ? resolution : resolution.result;
}

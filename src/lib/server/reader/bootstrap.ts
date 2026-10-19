import { GetObjectCommand } from '@aws-sdk/client-s3';
import { and, eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import {
  documentSettings,
  documents,
  userDocumentProgress,
  userPreferences,
} from '@openreader/database/schema';
import type { NextRequest } from 'next/server';
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
  resolveSegmentDocumentScope,
  type ResolvedSegmentDocumentScope,
} from '@/lib/server/tts/segments-auth';
import { nowTimestampMs } from '@/lib/shared/timestamps';
import { toBaseDocument, type StoredDocumentRow } from '@/lib/server/documents/document-row';
import { detectTextLanguage } from '@/lib/server/documents/text-language';
import { resolvePdfOperationReadiness } from './bootstrap-progress';
import { resolveReaderPlayback } from './playback';

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
  // Reuse the worker's parsed text; never parse a PDF again in the app. Bound
  // sampling before joining so large PDFs do not allocate a second full text.
  let detectedLanguage: string | null = null;
  if (!row.language && parsedPdfDocument) {
    const samples: string[] = [];
    let remaining = 60_000;
    for (const page of parsedPdfDocument.pages) {
      for (const block of page.blocks) {
        if (remaining <= 0) break;
        const text = block.text.slice(0, remaining);
        samples.push(text);
        remaining -= text.length + 1;
      }
      if (remaining <= 0) break;
    }
    detectedLanguage = detectTextLanguage(samples.join(' '));
  }
  const documentLanguage = row.language || detectedLanguage;
  const planResult = await resolveReaderPlayback(
    request, documentId, scope, settings, storedRecord(preferenceRows[0]?.dataJson), documentLanguage,
  );
  if ('result' in planResult) return planResult;

  const document: BaseDocument = toBaseDocument({ ...row, language: documentLanguage });
  await db.update(documents).set({
    recentlyOpenedAt: nowTimestampMs(),
    ...(detectedLanguage ? { language: detectedLanguage } : {}),
  }).where(and(
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
      playback: planResult.playback,
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
      playback: planResult.playback,
      initialPosition,
    };
  } else {
    payload = {
      documentId,
      readerType: 'html',
      document: { ...document, type: 'html' },
      settings,
      plan: planResult.plan,
      playback: planResult.playback,
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

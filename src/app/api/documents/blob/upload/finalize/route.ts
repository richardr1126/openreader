import path from 'path';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import {
  TEMP_DOCUMENT_UPLOAD_TTL_MS,
  copyObjectKeyToDocument,
  copyTempDocumentBlobToDocument,
  deleteTempDocumentUpload,
  getTempDocumentBlob,
  getTempDocumentFinalizeReceipt,
  headDocumentBlob,
  headTempDocumentBlob,
  isMissingBlobError,
  isPreconditionFailed,
  isValidTempUploadToken,
  putTempDocumentFinalizeReceipt,
} from '@/lib/server/documents/blobstore';
import {
  buildDocxConversionRequest,
  headTempUploadForConversion,
} from '@/lib/server/documents/docx-conversion-jobs';
import { registerUploadedDocument } from '@/lib/server/documents/register-upload';
import { withDocumentBlobLease } from '@/lib/server/documents/blob-lease';
import { safeDocumentName, toDocumentTypeFromName } from '@/lib/server/documents/utils';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import type {
  ComputeOperation,
  DocumentConversionArtifactMetadata,
} from '@/lib/server/compute-worker/protocol';
import { errorResponse } from '@/lib/server/errors/next-response';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';
import type { BaseDocument, DocumentType } from '@/types/documents';

export const dynamic = 'force-dynamic';

type FinalizeUpload = {
  token: string;
  name: string;
  type: DocumentType;
  lastModified: number;
};

type FinalizeReceipt = {
  stored: BaseDocument;
};

type PendingConversion = {
  token: string;
  name: string;
  conversionId: string;
  opId: string | null;
  status: 'queued' | 'running';
};

type FailedConversion = {
  token: string;
  name: string;
  conversionId: string;
  opId: string | null;
  status: 'failed';
  error: string;
};

type FinalizeResult =
  | { kind: 'stored'; stored: BaseDocument }
  | { kind: 'pending'; pending: PendingConversion }
  | { kind: 'failed'; failed: FailedConversion };

function s3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Documents storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
}

function normalizeDocumentType(rawType: unknown, safeName: string): DocumentType {
  if (rawType === 'pdf' || rawType === 'epub' || rawType === 'docx' || rawType === 'html') {
    return rawType;
  }
  return toDocumentTypeFromName(safeName);
}

function normalizeLastModified(value: unknown): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : Date.now();
}

function parseFinalizePayload(body: unknown): FinalizeUpload[] {
  if (!body || typeof body !== 'object') return [];
  const rawUploads = (body as { uploads?: unknown }).uploads;
  if (!Array.isArray(rawUploads)) return [];

  const uploads: FinalizeUpload[] = [];
  for (const rawUpload of rawUploads) {
    if (!rawUpload || typeof rawUpload !== 'object') continue;
    const rec = rawUpload as Record<string, unknown>;
    const token = typeof rec.token === 'string' ? rec.token.trim().toLowerCase() : '';
    if (!isValidTempUploadToken(token)) continue;
    const fallbackName = `upload-${token}.txt`;
    const name = safeDocumentName(typeof rec.name === 'string' ? rec.name : '', fallbackName);
    uploads.push({
      token,
      name,
      type: normalizeDocumentType(rec.type, name),
      lastModified: normalizeLastModified(rec.lastModified),
    });
  }
  return uploads;
}

async function loadTempUpload(input: {
  token: string;
  userId: string;
  namespace: string | null;
}): Promise<{ contentType: string; size: number; lastModified: number; body: Buffer }> {
  const RETRIES = 3;
  const RETRY_DELAY_MS = 500;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const head = await headTempDocumentBlob(input.token, input.userId, input.namespace);
      const body = await getTempDocumentBlob(input.token, input.userId, input.namespace);
      return {
        contentType: head.contentType ?? 'application/octet-stream',
        size: head.contentLength > 0 ? head.contentLength : body.byteLength,
        lastModified: head.lastModified ?? Date.now(),
        body,
      };
    } catch (error) {
      lastError = error;
      if (isMissingBlobError(error) && attempt < RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Temporary upload is unavailable');
}

async function registerConvertedDocx(input: {
  upload: FinalizeUpload;
  userId: string;
  namespace: string | null;
  artifact: DocumentConversionArtifactMetadata;
}): Promise<BaseDocument> {
  const finalizedName = safeDocumentName(`${path.parse(input.upload.name).name}.pdf`, 'upload.pdf');
  const documentId = input.artifact.documentId;

  const stored = await withDocumentBlobLease(documentId, async () => {
    try {
      await headDocumentBlob(documentId, input.namespace);
    } catch (error) {
      if (!isMissingBlobError(error)) throw error;
      try {
        await copyObjectKeyToDocument(
          input.artifact.objectKey,
          documentId,
          input.namespace,
          'application/pdf',
          { ifNoneMatch: true },
        );
      } catch (copyError) {
        if (!isPreconditionFailed(copyError)) throw copyError;
      }
    }

    const canonicalHead = await headDocumentBlob(documentId, input.namespace);
    return registerUploadedDocument({
      documentId,
      userId: input.userId,
      namespace: input.namespace,
      name: finalizedName,
      type: 'pdf',
      size: canonicalHead.contentLength > 0 ? canonicalHead.contentLength : input.artifact.byteLength,
      lastModified: input.upload.lastModified,
    });
  });

  await putTempDocumentFinalizeReceipt(
    input.upload.token,
    input.userId,
    input.namespace,
    Buffer.from(JSON.stringify({ stored }), 'utf8'),
  );

  await deleteTempDocumentUpload(input.upload.token, input.userId, input.namespace).catch((error) => {
    serverLogger.warn({
      event: 'documents.blob.upload.finalize.temp_delete_failed',
      degraded: true,
      fallbackPath: 'leave_temp_upload',
      documentId,
      token: input.upload.token,
      error: errorToLog(error),
    }, 'Failed to delete temp upload after DOCX conversion finalize');
  });

  return stored;
}

async function finalizeDocx(input: {
  upload: FinalizeUpload;
  userId: string;
  namespace: string | null;
}): Promise<FinalizeResult> {
  if (!isComputeWorkerAvailable()) {
    throw new Error('Compute worker is required for DOCX conversion.');
  }

  const temp = await headTempUploadForConversion({
    token: input.upload.token,
    userId: input.userId,
    namespace: input.namespace,
  });

  if (Date.now() - temp.lastModified > TEMP_DOCUMENT_UPLOAD_TTL_MS) {
    await deleteTempDocumentUpload(input.upload.token, input.userId, input.namespace).catch(() => undefined);
    throw new Error('Temporary upload expired before finalize');
  }

  const conversionRequest = buildDocxConversionRequest({
    upload: input.upload,
    temp,
    userId: input.userId,
    namespace: input.namespace,
  });
  const client = getComputeWorkerClient();
  const resolved = await client.resolveDocumentConversion(conversionRequest);
  if (resolved.artifact) {
    return {
      kind: 'stored',
      stored: await registerConvertedDocx({
        upload: input.upload,
        userId: input.userId,
        namespace: input.namespace,
        artifact: resolved.artifact,
      }),
    };
  }

  const operation: ComputeOperation | null = resolved.operation?.status === 'failed'
    ? resolved.operation
    : await client.createDocumentConversionOperation(conversionRequest);
  if (operation?.status === 'failed') {
    return {
      kind: 'failed',
      failed: {
        token: input.upload.token,
        name: input.upload.name,
        conversionId: conversionRequest.conversionId,
        opId: operation.opId ?? null,
        status: 'failed',
        error: operation.error?.message ?? 'DOCX conversion failed',
      },
    };
  }

  return {
    kind: 'pending',
    pending: {
      token: input.upload.token,
      name: input.upload.name,
      conversionId: conversionRequest.conversionId,
      opId: operation?.opId ?? resolved.operation?.opId ?? null,
      status: operation?.status === 'running' || resolved.operation?.status === 'running' ? 'running' : 'queued',
    },
  };
}

async function finalizeOne(input: {
  upload: FinalizeUpload;
  userId: string;
  namespace: string | null;
}): Promise<FinalizeResult> {
  const existingReceipt = await getTempDocumentFinalizeReceipt<FinalizeReceipt>(
    input.upload.token,
    input.userId,
    input.namespace,
  );
  if (existingReceipt?.stored) {
    return { kind: 'stored', stored: existingReceipt.stored };
  }

  const isDocxUpload = input.upload.type === 'docx';
  if (isDocxUpload) {
    return finalizeDocx(input);
  }

  const temp = await loadTempUpload({
    token: input.upload.token,
    userId: input.userId,
    namespace: input.namespace,
  });

  if (Date.now() - temp.lastModified > TEMP_DOCUMENT_UPLOAD_TTL_MS) {
    await deleteTempDocumentUpload(input.upload.token, input.userId, input.namespace).catch(() => undefined);
    throw new Error('Temporary upload expired before finalize');
  }

  const finalizedType: DocumentType = input.upload.type;
  const finalizedBody = temp.body;
  const finalizedContentType = finalizedType === 'pdf'
    ? 'application/pdf'
    : temp.contentType;
  const finalizedName = input.upload.name;
  const documentId = createHash('sha256').update(finalizedBody).digest('hex');

  const stored = await withDocumentBlobLease(documentId, async () => {
    // Keep the canonical blob and ownership-row write under the same durable
    // lease so the orphan reaper cannot delete between its ownership check and
    // this registration.
    try {
      await headDocumentBlob(documentId, input.namespace);
    } catch (error) {
      if (!isMissingBlobError(error)) throw error;
      try {
        await copyTempDocumentBlobToDocument(
          input.upload.token,
          input.userId,
          documentId,
          input.namespace,
          finalizedContentType,
          { ifNoneMatch: true },
        );
      } catch (copyError) {
        if (!isPreconditionFailed(copyError)) throw copyError;
      }
    }

    const canonicalHead = await headDocumentBlob(documentId, input.namespace);
    return registerUploadedDocument({
      documentId,
      userId: input.userId,
      namespace: input.namespace,
      name: finalizedName,
      type: finalizedType,
      size: canonicalHead.contentLength > 0 ? canonicalHead.contentLength : finalizedBody.byteLength,
      lastModified: input.upload.lastModified,
    });
  });

  await putTempDocumentFinalizeReceipt(
    input.upload.token,
    input.userId,
    input.namespace,
    Buffer.from(JSON.stringify({ stored }), 'utf8'),
  );

  await deleteTempDocumentUpload(input.upload.token, input.userId, input.namespace).catch((error) => {
    serverLogger.warn({
      event: 'documents.blob.upload.finalize.temp_delete_failed',
      degraded: true,
      fallbackPath: 'leave_temp_upload',
      documentId,
      token: input.upload.token,
      error: errorToLog(error),
    }, 'Failed to delete temp upload after finalize');
  });

  return { kind: 'stored', stored };
}

export async function POST(req: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = ctxOrRes.userId;

    const namespace = getOpenReaderTestNamespace(req.headers);
    const uploads = parseFinalizePayload(await req.json().catch(() => null));
    if (uploads.length === 0) {
      return NextResponse.json({ error: 'No valid uploads provided' }, { status: 400 });
    }

    const results = await Promise.all(
      uploads.map((upload) => finalizeOne({
        upload,
        userId,
        namespace,
      })),
    );
    const stored = results
      .filter((result): result is Extract<FinalizeResult, { kind: 'stored' }> => result.kind === 'stored')
      .map((result) => result.stored);
    const conversions = results
      .filter((result): result is Extract<FinalizeResult, { kind: 'pending' }> => result.kind === 'pending')
      .map((result) => result.pending);
    const failedConversions = results
      .filter((result): result is Extract<FinalizeResult, { kind: 'failed' }> => result.kind === 'failed')
      .map((result) => result.failed);

    if (failedConversions.length > 0) {
      return NextResponse.json({
        stored,
        conversions: failedConversions,
        error: failedConversions[0]?.error ?? 'DOCX conversion failed',
      }, { status: 409 });
    }

    if (conversions.length > 0) {
      return NextResponse.json({ stored, conversions }, { status: 202 });
    }

    return NextResponse.json({ stored });
  } catch (error) {
    if (error instanceof Error && error.message === 'Temporary upload expired before finalize') {
      return NextResponse.json({ error: error.message }, { status: 410 });
    }
    if (error instanceof Error && error.message === 'Compute worker is required for DOCX conversion.') {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    if (isMissingBlobError(error)) {
      return NextResponse.json({ error: 'Temporary upload missing. Upload bytes again and retry finalize.' }, { status: 409 });
    }

    serverLogger.error({
      event: 'documents.blob.upload.finalize.failed',
      error: errorToLog(error),
    }, 'Failed to finalize uploaded documents');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to finalize uploaded documents',
      normalize: { code: 'DOCUMENTS_BLOB_UPLOAD_FINALIZE_FAILED', errorClass: 'storage' },
    });
  }
}

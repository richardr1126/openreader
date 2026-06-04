import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import {
  TEMP_DOCUMENT_UPLOAD_TTL_MS,
  copyTempDocumentBlobToDocument,
  deleteTempDocumentUpload,
  getTempDocumentBlob,
  getTempDocumentFinalizeReceipt,
  headDocumentBlob,
  headTempDocumentBlob,
  isMissingBlobError,
  isValidTempUploadToken,
  putTempDocumentFinalizeReceipt,
} from '@/lib/server/documents/blobstore';
import { registerUploadedDocument } from '@/lib/server/documents/register-upload';
import { safeDocumentName, toDocumentTypeFromName } from '@/lib/server/documents/utils';
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

async function finalizeOne(input: {
  upload: FinalizeUpload;
  userId: string;
  namespace: string | null;
}): Promise<BaseDocument> {
  const existingReceipt = await getTempDocumentFinalizeReceipt<FinalizeReceipt>(
    input.upload.token,
    input.userId,
    input.namespace,
  );
  if (existingReceipt?.stored) {
    return existingReceipt.stored;
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

  const documentId = createHash('sha256').update(temp.body).digest('hex');

  try {
    await headDocumentBlob(documentId, input.namespace);
  } catch (error) {
    if (!isMissingBlobError(error)) throw error;
    await copyTempDocumentBlobToDocument(
      input.upload.token,
      input.userId,
      documentId,
      input.namespace,
      temp.contentType,
    );
  }

  const canonicalHead = await headDocumentBlob(documentId, input.namespace);
  const stored = await registerUploadedDocument({
    documentId,
    userId: input.userId,
    namespace: input.namespace,
    name: input.upload.name,
    type: input.upload.type,
    size: canonicalHead.contentLength > 0 ? canonicalHead.contentLength : temp.size,
    lastModified: input.upload.lastModified,
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

  return stored;
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

    const stored: BaseDocument[] = [];
    for (const upload of uploads) {
      stored.push(await finalizeOne({
        upload,
        userId,
        namespace,
      }));
    }

    return NextResponse.json({ stored });
  } catch (error) {
    if (error instanceof Error && error.message === 'Temporary upload expired before finalize') {
      return NextResponse.json({ error: error.message }, { status: 410 });
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

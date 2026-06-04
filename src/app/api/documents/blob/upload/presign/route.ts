import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import {
  TEMP_DOCUMENT_UPLOAD_TTL_MS,
  deleteExpiredTempDocumentUploads,
  presignTempPut,
} from '@/lib/server/documents/blobstore';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

type PresignUpload = {
  contentType: string;
  size: number;
};

function parseUploads(body: unknown): PresignUpload[] {
  if (!body || typeof body !== 'object') return [];
  const rawUploads = (body as { uploads?: unknown }).uploads;
  if (!Array.isArray(rawUploads)) return [];

  const uploads: PresignUpload[] = [];
  for (const raw of rawUploads) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    const contentType =
      typeof rec.contentType === 'string' && rec.contentType.trim()
        ? rec.contentType.trim()
        : 'application/octet-stream';
    const size = Number.isFinite(rec.size) && Number(rec.size) >= 0 ? Number(rec.size) : 0;
    uploads.push({ contentType, size });
  }
  return uploads;
}

export async function POST(req: NextRequest) {
  try {
    if (!isS3Configured()) {
      return NextResponse.json(
        { error: 'Documents storage is not configured. Set S3_* environment variables.' },
        { status: 503 },
      );
    }

    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const userId = ctxOrRes.userId;

    const body = await req.json().catch(() => null);
    const uploads = parseUploads(body);
    if (uploads.length === 0) {
      return NextResponse.json({ error: 'No valid uploads provided' }, { status: 400 });
    }

    const { maxUploadMb } = await getResolvedRuntimeConfig();
    const maxUploadBytes = maxUploadMb * 1024 * 1024;
    const oversized = uploads.find((upload) => upload.size > maxUploadBytes);
    if (oversized) {
      return NextResponse.json(
        {
          error: `Upload exceeds the maximum allowed size of ${maxUploadBytes} bytes`,
          maxBytes: maxUploadBytes,
        },
        { status: 413 },
      );
    }

    const namespace = getOpenReaderTestNamespace(req.headers);
    await deleteExpiredTempDocumentUploads(userId, namespace, Date.now() - TEMP_DOCUMENT_UPLOAD_TTL_MS)
      .catch(() => undefined);
    const signed = await Promise.all(
      uploads.map(async (upload) => {
        const token = randomUUID();
        const res = await presignTempPut(token, userId, upload.contentType, namespace, {
          contentLength: upload.size,
        });
        return {
          token,
          url: res.url,
          headers: res.headers,
        };
      }),
    );

    return NextResponse.json({ uploads: signed });
  } catch (error) {
    serverLogger.error({
      event: 'documents.blob.upload.presign.failed',
      error: errorToLog(error),
    }, 'Failed to create document upload signatures');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to presign uploads',
      normalize: { code: 'DOCUMENTS_BLOB_UPLOAD_PRESIGN_FAILED', errorClass: 'storage' },
    });
  }
}

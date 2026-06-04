import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { isValidTempUploadToken, putTempDocumentBlob } from '@/lib/server/documents/blobstore';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

function isPreconditionFailed(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const maybe = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return maybe.$metadata?.httpStatusCode === 412 || maybe.name === 'PreconditionFailed';
}

export async function PUT(req: NextRequest) {
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

    const url = new URL(req.url);
    const token = (url.searchParams.get('token') || '').trim().toLowerCase();
    if (!isValidTempUploadToken(token)) {
      return NextResponse.json({ error: 'Invalid upload token' }, { status: 400 });
    }

    const contentType = (req.headers.get('content-type') || 'application/octet-stream').trim() || 'application/octet-stream';

    const { maxUploadMb } = await getResolvedRuntimeConfig();
    const maxUploadBytes = maxUploadMb * 1024 * 1024;
    // Reject before buffering when the declared length is already over the cap.
    const declaredLength = Number(req.headers.get('content-length') || '');
    if (Number.isFinite(declaredLength) && declaredLength > maxUploadBytes) {
      return NextResponse.json(
        { error: `Upload exceeds the maximum allowed size of ${maxUploadBytes} bytes`, maxBytes: maxUploadBytes },
        { status: 413 },
      );
    }

    // Backstop for chunked/omitted Content-Length: stream the body so we can
    // bail out as soon as the running total crosses the cap instead of
    // buffering the entire payload first.
    const stream = req.body;
    if (!stream) {
      return NextResponse.json({ error: 'Missing request body' }, { status: 400 });
    }
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    let overLimit = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (totalBytes > maxUploadBytes) {
          overLimit = true;
          break;
        }
        chunks.push(value);
      }
    } finally {
      if (overLimit) {
        await reader.cancel().catch(() => {});
      }
      reader.releaseLock();
    }
    if (overLimit) {
      return NextResponse.json(
        { error: `Upload exceeds the maximum allowed size of ${maxUploadBytes} bytes`, maxBytes: maxUploadBytes },
        { status: 413 },
      );
    }
    const body = Buffer.concat(chunks, totalBytes);

    const namespace = getOpenReaderTestNamespace(req.headers);

    try {
      await putTempDocumentBlob(token, ctxOrRes.userId, body, contentType, namespace);
    } catch (error) {
      if (!isPreconditionFailed(error)) {
        throw error;
      }
    }

    serverLogger.info({
      event: 'documents.blob.upload.fallback.proxy_used',
      degraded: true,
      fallbackPath: 'upload_proxy',
      uploadToken: token,
      contentType,
      bytes: body.byteLength,
    }, 'Document upload fallback proxy used');

    return NextResponse.json({ success: true, token });
  } catch (error) {
    serverLogger.error({
      event: 'documents.blob.upload.fallback.failed',
      error: errorToLog(error),
    }, 'Failed to proxy-upload document blob');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to upload document blob',
      normalize: { code: 'DOCUMENTS_BLOB_UPLOAD_FALLBACK_FAILED', errorClass: 'storage' },
    });
  }
}

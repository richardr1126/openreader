import { NextRequest, NextResponse } from 'next/server';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { isValidDocumentId, putDocumentBlob } from '@/lib/server/documents/blobstore';
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

    const url = new URL(req.url);
    const id = (url.searchParams.get('id') || '').trim().toLowerCase();
    if (!isValidDocumentId(id)) {
      return NextResponse.json({ error: 'Invalid document id' }, { status: 400 });
    }

    const contentType = (req.headers.get('content-type') || 'application/octet-stream').trim() || 'application/octet-stream';
    const body = Buffer.from(await req.arrayBuffer());
    const namespace = getOpenReaderTestNamespace(req.headers);

    try {
      await putDocumentBlob(id, body, contentType, namespace);
    } catch (error) {
      if (!isPreconditionFailed(error)) {
        throw error;
      }
    }

    serverLogger.info({
      event: 'documents.blob.upload.fallback.proxy_used',
      degraded: true,
      fallbackPath: 'upload_proxy',
      documentId: id,
      contentType,
      bytes: body.byteLength,
    }, 'Document upload fallback proxy used');

    return NextResponse.json({ success: true, id });
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

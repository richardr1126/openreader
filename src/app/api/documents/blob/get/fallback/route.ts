import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { contentTypeForName } from '@/lib/server/storage/library-mount';
import { getDocumentBlob, isMissingBlobError, isValidDocumentId } from '@/lib/server/documents/blobstore';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { isS3Configured } from '@/lib/server/storage/s3';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

function s3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Documents storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
}

function streamBuffer(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

export async function GET(req: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;
    if (!ctxOrRes.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const storageUserId = ctxOrRes.userId;
    const allowedUserIds = [storageUserId];

    const url = new URL(req.url);
    const id = (url.searchParams.get('id') || '').trim().toLowerCase();
    if (!isValidDocumentId(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    serverLogger.info({
      event: 'documents.blob.get.fallback.proxy_used',
      degraded: true,
      fallbackPath: 'download_proxy',
      documentId: id,
    }, 'Document download fallback proxy used');

    const rows = (await db
      .select({ id: documents.id, userId: documents.userId, name: documents.name })
      .from(documents)
      .where(and(eq(documents.id, id), inArray(documents.userId, allowedUserIds)))) as Array<{
      id: string;
      userId: string;
      name: string;
    }>;

    const doc = rows.find((row) => row.userId === storageUserId) ?? rows[0];
    if (!doc) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const filename = doc.name || `${id}.bin`;
    const responseType = contentTypeForName(filename);

    try {
      const content = await getDocumentBlob(id, testNamespace);
      return new NextResponse(streamBuffer(content), {
        headers: {
          'Content-Type': responseType,
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      if (isMissingBlobError(error)) {
        await db
          .delete(documents)
          .where(and(eq(documents.id, id), inArray(documents.userId, allowedUserIds)));
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      throw error;
    }
  } catch (error) {
    serverLogger.error({
      event: 'documents.blob.get.fallback.failed',
      error: errorToLog(error),
    }, 'Failed to load document content fallback');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to load document content',
      normalize: { code: 'DOCUMENTS_BLOB_GET_FALLBACK_FAILED', errorClass: 'storage' },
    });
  }
}

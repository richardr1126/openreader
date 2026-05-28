import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { isValidDocumentId, presignGet } from '@/lib/server/documents/blobstore';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/testing/test-namespace';
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

export async function GET(req: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const ctxOrRes = await requireAuthContext(req);
    if (ctxOrRes instanceof Response) return ctxOrRes;

    const testNamespace = getOpenReaderTestNamespace(req.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
    const storageUserId = ctxOrRes.userId ?? unclaimedUserId;
    const allowedUserIds = ctxOrRes.authEnabled ? [storageUserId, unclaimedUserId] : [unclaimedUserId];

    const url = new URL(req.url);
    const id = (url.searchParams.get('id') || '').trim().toLowerCase();
    if (!isValidDocumentId(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const rows = (await db
      .select({ id: documents.id, userId: documents.userId })
      .from(documents)
      .where(and(eq(documents.id, id), inArray(documents.userId, allowedUserIds)))) as Array<{
      id: string;
      userId: string;
    }>;

    const doc = rows.find((row) => row.userId === storageUserId) ?? rows[0];
    if (!doc) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const fallbackUrl = `/api/documents/blob/get/fallback?id=${encodeURIComponent(doc.id)}`;
    const directUrl = await presignGet(doc.id, testNamespace).catch(() => null);
    if (!directUrl) {
      serverLogger.warn({
        event: 'documents.blob.get.presign.unavailable',
        degraded: true,
        fallbackPath: 'download_proxy',
        documentId: doc.id,
      }, 'Presigned document download unavailable, redirecting to proxy fallback');
      return NextResponse.redirect(fallbackUrl, {
        status: 307,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    return NextResponse.redirect(directUrl, {
      status: 307,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    serverLogger.error({
      event: 'documents.blob.get.presign.failed',
      error: errorToLog(error),
    }, 'Failed to create document download signature');
    return errorResponse(error, {
      apiErrorMessage: 'Failed to prepare document download',
      normalize: { code: 'DOCUMENTS_BLOB_GET_PRESIGN_FAILED', errorClass: 'storage' },
    });
  }
}

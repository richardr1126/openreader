import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents } from '@openreader/database/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { isValidDocumentId, presignGet } from '@/lib/server/documents/blobstore';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { getBrowserStorageTransport, isS3Configured } from '@/lib/server/storage/s3';
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
    if (getBrowserStorageTransport() !== 'presigned') {
      return NextResponse.json({ error: 'Presigned document delivery is disabled when S3_BROWSER_TRANSPORT=proxy.' }, { status: 409 });
    }

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

    const directUrl = await presignGet(doc.id, testNamespace);

    return NextResponse.redirect(directUrl, {
      status: 307,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return errorResponse(error, {
      apiErrorMessage: 'Failed to prepare document download',
      normalize: { code: 'DOCUMENTS_BLOB_GET_PRESIGN_FAILED', errorClass: 'storage' },
    });
  }
}

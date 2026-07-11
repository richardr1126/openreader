import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents } from '@openreader/database/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getDocumentBlobStream, headDocumentBlob, isValidDocumentId } from '@/lib/server/documents/blobstore';
import { getBrowserStorageTransport, isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace } from '@/lib/server/testing/test-namespace';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    if (!isS3Configured()) return NextResponse.json({ error: 'Documents storage is not configured. Set S3_* environment variables.' }, { status: 503 });
    if (getBrowserStorageTransport() !== 'proxy') return NextResponse.json({ error: 'Proxy document delivery is disabled when S3_BROWSER_TRANSPORT=presigned.' }, { status: 409 });
    const auth = await requireAuthContext(req);
    if (auth instanceof Response) return auth;
    if (!auth.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const id = req.nextUrl.searchParams.get('id')?.trim().toLowerCase() || '';
    if (!isValidDocumentId(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const rows = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.id, id), inArray(documents.userId, [auth.userId]))).limit(1);
    if (!rows[0]) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const namespace = getOpenReaderTestNamespace(req.headers);
    const [head, body] = await Promise.all([headDocumentBlob(id, namespace), getDocumentBlobStream(id, namespace)]);
    return new NextResponse(body as BodyInit, { headers: { 'Content-Type': head.contentType || 'application/octet-stream', 'Content-Length': String(head.contentLength), 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return errorResponse(error, { apiErrorMessage: 'Failed to download document', normalize: { code: 'DOCUMENTS_BLOB_GET_FAILED', errorClass: 'storage' } });
  }
}

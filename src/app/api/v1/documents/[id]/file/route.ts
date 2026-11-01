import { NextRequest, NextResponse } from 'next/server';
import { documentApi } from '@/lib/server/documents/request';
import { requireDocument } from '@/lib/server/documents/resources';
import { getDocumentBlobStream, headDocumentBlob, presignGet } from '@/lib/server/documents/blobstore';
import { getBrowserStorageTransport } from '@/lib/server/storage/s3';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return documentApi(request, 'documents:read', async caller => {
    const document = await requireDocument(caller.principal, (await context.params).id);
    if (getBrowserStorageTransport() === 'presigned') return NextResponse.redirect(await presignGet(document.id, null), 307);
    const [head, stream] = await Promise.all([headDocumentBlob(document.id, null), getDocumentBlobStream(document.id, null)]);
    return new NextResponse(stream as BodyInit, { headers: { 'Content-Type': head.contentType || 'application/octet-stream', 'Content-Length': String(head.contentLength) } });
  });
}

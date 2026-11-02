import { NextRequest, NextResponse } from 'next/server';
import { documentApi } from '@/lib/server/documents/request';
import { requireDocument } from '@/lib/server/documents/resources';
import { getDocumentBlobStream, headDocumentBlob, presignGet } from '@/lib/server/documents/blobstore';
import { attachmentDisposition, documentContentType } from '@/lib/server/documents/utils';
import { getBrowserStorageTransport } from '@/lib/server/storage/s3';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return documentApi(request, 'documents:read', async caller => {
    const document = await requireDocument(caller.principal, (await context.params).id);
    const contentType = documentContentType(document.name);
    const disposition = attachmentDisposition(document.name);
    if (getBrowserStorageTransport() === 'presigned') return NextResponse.redirect(await presignGet(document.id, null, { contentType, disposition }), 307);
    const [head, stream] = await Promise.all([headDocumentBlob(document.id, null), getDocumentBlobStream(document.id, null)]);
    return new NextResponse(stream as BodyInit, { headers: {
      'Content-Type': contentType,
      'Content-Length': String(head.contentLength),
      'Content-Disposition': disposition,
      'Content-Security-Policy': "sandbox; default-src 'none'",
    } });
  });
}

import { NextRequest, NextResponse } from 'next/server';
import { ApiRequestError } from '@/lib/server/api/responses';
import { documentApi, documentBody } from '@/lib/server/documents/request';
import { createDocument } from '@/lib/server/documents/create';
import { listDocumentResources, removeDocuments, updateDocuments } from '@/lib/server/documents/resources';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return documentApi(request, 'documents:read', async caller => NextResponse.json(await listDocumentResources(caller.principal, request.nextUrl.searchParams)));
}

export function POST(request: NextRequest) {
  return documentApi(request, 'documents:write', async caller => {
    const upload = await createDocument(caller, await documentBody(request));
    const response = NextResponse.json(upload.document ?? upload, { status: upload.document ? 201 : 202 });
    response.headers.set('Location', upload.document ? `/api/v1/documents/${upload.document.id}` : upload.statusUrl);
    return response;
  });
}

export function PATCH(request: NextRequest) {
  return documentApi(request, 'documents:write', async caller => {
    const patch = await documentBody(request);
    if (!Array.isArray(patch.ids) || !patch.ids.every(id => typeof id === 'string')) throw new ApiRequestError(400, 'REQUEST_INVALID', 'ids is required.');
    return NextResponse.json(await updateDocuments(caller, patch.ids, patch));
  });
}

export function DELETE(request: NextRequest) {
  return documentApi(request, 'documents:write', async caller => {
    const ids = request.nextUrl.searchParams.get('ids');
    if (!ids) throw new ApiRequestError(400, 'REQUEST_INVALID', 'ids is required.');
    return NextResponse.json(await removeDocuments(caller, ids.split(',')));
  });
}

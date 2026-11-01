import { NextRequest, NextResponse } from 'next/server';
import { documentApi, documentBody } from '@/lib/server/documents/request';
import { describeDocument, requireDocument, removeDocuments, updateDocuments } from '@/lib/server/documents/resources';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export function GET(request: NextRequest, context: Context) {
  return documentApi(request, 'documents:read', async caller => NextResponse.json(await describeDocument(await requireDocument(caller.principal, (await context.params).id))));
}

export function PATCH(request: NextRequest, context: Context) {
  return documentApi(request, 'documents:write', async caller => {
    const patch = await documentBody(request);
    const result = await updateDocuments(caller, [(await context.params).id], patch);
    return NextResponse.json(await describeDocument(result.data[0]));
  });
}

export function DELETE(request: NextRequest, context: Context) {
  return documentApi(request, 'documents:write', async caller => {
    const id = (await context.params).id;
    await requireDocument(caller.principal, id);
    await removeDocuments(caller, [id]);
    return new NextResponse(null, { status: 204 });
  });
}

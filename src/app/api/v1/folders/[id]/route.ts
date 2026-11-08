import { NextRequest, NextResponse } from 'next/server';
import { apiRequest } from '@/lib/server/api/request';
import { readApiJson } from '@/lib/server/api/body';
import { deleteFolder, updateFolder } from '@/lib/server/folders';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export function PATCH(request: NextRequest, context: Context) {
  return apiRequest(request, 'documents:write', async principal => NextResponse.json(await updateFolder(principal, (await context.params).id, await readApiJson(request, 64 * 1024))));
}
export function DELETE(request: NextRequest, context: Context) {
  return apiRequest(request, 'documents:write', async principal => {
    await deleteFolder(principal, (await context.params).id);
    return new NextResponse(null, { status: 204 });
  });
}

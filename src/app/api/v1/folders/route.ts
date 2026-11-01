import { NextRequest, NextResponse } from 'next/server';
import { apiRequest } from '@/lib/server/api/request';
import { readApiJson } from '@/lib/server/api/body';
import { createFolder, deleteFolder, listFolders } from '@/lib/server/folders';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest) {
  return apiRequest(request, 'documents:read', async principal => NextResponse.json(await listFolders(principal, request.nextUrl.searchParams)));
}
export function POST(request: NextRequest) {
  return apiRequest(request, 'documents:write', async principal => {
    const folder = await createFolder(principal, await readApiJson(request, 64 * 1024));
    return NextResponse.json(folder, { status: 201, headers: { Location: `/api/v1/folders/${folder.id}` } });
  });
}
export function DELETE(request: NextRequest) {
  return apiRequest(request, 'documents:write', async principal => {
    await deleteFolder(principal);
    return new NextResponse(null, { status: 204 });
  });
}

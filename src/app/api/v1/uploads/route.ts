import { NextRequest, NextResponse } from 'next/server';
import { readApiJson } from '@/lib/server/api/body';
import { documentApi } from '@/lib/server/documents/request';
import { prepareDocumentUpload } from '@/lib/server/documents/uploads';

export const dynamic = 'force-dynamic';

export function POST(request: NextRequest) {
  return documentApi(request, 'documents:write', async caller => {
    const body = await readApiJson(request);
    return NextResponse.json(await prepareDocumentUpload(caller, body), { status: 201 });
  });
}

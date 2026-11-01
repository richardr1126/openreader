import { NextRequest, NextResponse } from 'next/server';
import { documentApi } from '@/lib/server/documents/request';
import { readDocumentUpload, uploadId } from '@/lib/server/documents/uploads';

export const dynamic = 'force-dynamic';

export function GET(request: NextRequest, context: { params: Promise<{ uploadId: string }> }) {
  return documentApi(request, 'documents:write', async caller => NextResponse.json(await readDocumentUpload(caller, uploadId((await context.params).uploadId))));
}

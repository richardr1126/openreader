import { NextRequest, NextResponse } from 'next/server';
import { documentApi } from '@/lib/server/documents/request';
import { receiveDocumentUpload, uploadId } from '@/lib/server/documents/uploads';

export const dynamic = 'force-dynamic';

export function PUT(request: NextRequest, context: { params: Promise<{ uploadId: string }> }) {
  return documentApi(request, 'documents:write', async caller => {
    await receiveDocumentUpload(caller, uploadId((await context.params).uploadId), request.body);
    return new NextResponse(null, { status: 204 });
  });
}

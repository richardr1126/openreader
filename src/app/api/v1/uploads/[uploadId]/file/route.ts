import { NextRequest, NextResponse } from 'next/server';
import { documentApi, documentCaller, documentRequestFailure } from '@/lib/server/documents/request';
import { hasUploadLinkSignature, verifyUploadLink } from '@/lib/server/documents/upload-links';
import { receiveDocumentUpload, uploadId } from '@/lib/server/documents/uploads';
import { createRequestLogger } from '@/lib/server/logger';

export const dynamic = 'force-dynamic';

export async function PUT(request: NextRequest, context: { params: Promise<{ uploadId: string }> }) {
  // A signed link from the MCP "docs upload" command stands in for a token, for this upload only.
  if (hasUploadLinkSignature(request.nextUrl.searchParams)) {
    const { logger } = createRequestLogger({ route: request.nextUrl.pathname, request });
    try {
      const id = uploadId((await context.params).uploadId);
      await receiveDocumentUpload(documentCaller(verifyUploadLink(id, request.nextUrl.searchParams)), id, request.body);
      return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
      return documentRequestFailure(error, logger);
    }
  }
  return documentApi(request, 'documents:write', async caller => {
    await receiveDocumentUpload(caller, uploadId((await context.params).uploadId), request.body);
    return new NextResponse(null, { status: 204 });
  });
}

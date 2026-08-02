import { NextRequest, NextResponse } from 'next/server';
import { isValidDocumentId } from '@/lib/server/documents/blobstore';
import { errorResponse } from '@/lib/server/errors/next-response';
import { createRequestLogger } from '@/lib/server/logger';
import { resolveReaderBootstrap } from '@/lib/server/reader/bootstrap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { logger } = createRequestLogger({
    route: '/api/documents/[id]/reader-bootstrap',
    request,
  });
  try {
    const { id: rawId } = await context.params;
    const documentId = rawId.trim().toLowerCase();
    if (!isValidDocumentId(documentId)) {
      return NextResponse.json(
        { status: 'error', message: 'Invalid document id.', retryable: false },
        { status: 400 },
      );
    }
    const body = await request.json().catch(() => null) as { pdfOperationId?: unknown } | null;
    const pdfOperationId = typeof body?.pdfOperationId === 'string'
      ? body.pdfOperationId.trim()
      : null;
    const result = await resolveReaderBootstrap(request, documentId, { pdfOperationId });
    return result instanceof Response ? result : NextResponse.json(result, {
      status: result.status === 'pending' ? 202 : 200,
      headers: {
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie, Authorization',
      },
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'reader.bootstrap.failed',
      msg: 'Failed to bootstrap reader',
      apiErrorMessage: 'Failed to prepare reader',
      normalize: { code: 'READER_BOOTSTRAP_FAILED', errorClass: 'unknown' },
    });
  }
}

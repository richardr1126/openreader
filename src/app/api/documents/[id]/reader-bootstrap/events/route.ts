import { NextRequest, NextResponse } from 'next/server';
import { isValidDocumentId } from '@/lib/server/documents/blobstore';
import { errorResponse } from '@/lib/server/errors/next-response';
import { createRequestLogger } from '@/lib/server/logger';
import { resolveReaderBootstrapState } from '@/lib/server/reader/bootstrap';
import { createReaderBootstrapEventStream } from '@/lib/server/reader/bootstrap-events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { logger } = createRequestLogger({
    route: '/api/documents/[id]/reader-bootstrap/events',
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
    const preparationOperationId = request.nextUrl.searchParams.get('operationId')?.trim() || null;
    const resolveOptions = { preparationOperationId };
    const initial = await resolveReaderBootstrapState(request, documentId, resolveOptions);
    if (initial instanceof Response) return initial;

    return new NextResponse(
      createReaderBootstrapEventStream(request, documentId, initial, resolveOptions),
      {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'private, no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          Vary: 'Cookie, Authorization',
        },
      },
    );
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'reader.bootstrap.events_failed',
      msg: 'Failed to observe reader bootstrap',
      apiErrorMessage: 'Failed to observe reader bootstrap',
      normalize: { code: 'READER_BOOTSTRAP_EVENTS_FAILED', errorClass: 'upstream' },
    });
  }
}

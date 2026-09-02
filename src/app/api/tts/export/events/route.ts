import { NextRequest, NextResponse } from 'next/server';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { proxyOperationEvents } from '@/lib/server/compute-worker/operation-events-proxy';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const { logger } = createRequestLogger({
    route: '/api/tts/export/events',
    request,
  });
  try {
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json(
        { error: 'Compute worker is required for audiobook export.' },
        { status: 503 },
      );
    }

    const opId = request.nextUrl.searchParams.get('opId')?.trim() ?? '';
    const documentId = request.nextUrl.searchParams.get('documentId')?.trim().toLowerCase() ?? '';
    if (!opId || !documentId) {
      return NextResponse.json({ error: 'opId and documentId are required' }, { status: 400 });
    }

    const scope = await resolveSegmentDocumentScope(request, documentId);
    if (scope instanceof Response) return scope;

    const operation = await getComputeWorkerClient().getOperation(opId);
    if (!operation) return NextResponse.json({ error: 'Operation not found' }, { status: 404 });
    if (
      operation.subject.kind !== 'tts_playback_export'
      && operation.subject.kind !== 'tts_playback'
    ) {
      return NextResponse.json({ error: 'Operation does not belong to this export' }, { status: 403 });
    }
    if (operation.subject.documentId !== documentId) {
      return NextResponse.json({ error: 'Operation does not belong to this export' }, { status: 403 });
    }

    return await proxyOperationEvents({
      request,
      opId,
      streamErrorMessage: 'Failed to proxy audiobook export event stream',
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.export.events_failed',
      msg: 'Failed to proxy audiobook export events',
      apiErrorMessage: 'Failed to proxy audiobook export events',
      normalize: { code: 'TTS_EXPORT_EVENTS_FAILED', errorClass: 'upstream' },
    });
  }
}

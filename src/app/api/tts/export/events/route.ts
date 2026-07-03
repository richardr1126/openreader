import { NextRequest, NextResponse } from 'next/server';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
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
    const isExportOperation = operation.subject.kind === 'tts_playback_export';
    const isGenerationOperation = operation.subject.kind === 'tts_playback';
    if ((!isExportOperation && !isGenerationOperation) || operation.subject.documentId !== documentId) {
      return NextResponse.json({ error: 'Operation does not belong to this export' }, { status: 403 });
    }

    const lastEventId = request.headers.get('last-event-id');
    const sinceEventId = request.nextUrl.searchParams.get('sinceEventId') || lastEventId;
    const upstream = await getComputeWorkerClient().openOperationEvents(opId, {
      sinceEventId,
      lastEventId,
      signal: request.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      return NextResponse.json(
        { error: detail || 'Failed to proxy audiobook export event stream' },
        { status: upstream.status || 502 },
      );
    }

    return new NextResponse(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
        'Cache-Control': upstream.headers.get('cache-control') || 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
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

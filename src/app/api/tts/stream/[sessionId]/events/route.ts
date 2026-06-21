import { NextRequest, NextResponse } from 'next/server';
import { resolveTtsPlaybackSession } from '@/lib/server/tts/playback-sessions';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * Proxy the worker's operation-events SSE stream for a TTS playback session so the
 * client can react to "segment ready" progress (refetch timeline + nudge the
 * audio player) without polling. The long-lived connection lives on the worker;
 * this route just pipes it through. Vercel caps the function at 5 min, so the
 * client's EventSource reconnects with Last-Event-ID / sinceEventId to resume.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { logger } = createRequestLogger({
    route: '/api/tts/stream/[sessionId]/events',
    request,
  });
  try {
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json(
        { error: 'Compute worker is required for progressive TTS playback.' },
        { status: 503 },
      );
    }

    const { sessionId } = await context.params;
    const session = await resolveTtsPlaybackSession(request, sessionId);
    if (session instanceof Response) return session;

    if (!session.workerOpId) {
      return NextResponse.json({ error: 'Playback session has no worker operation yet' }, { status: 409 });
    }

    const lastEventId = request.headers.get('last-event-id');
    const sinceEventId = request.nextUrl.searchParams.get('sinceEventId') || lastEventId;
    const upstream = await getComputeWorkerClient().openOperationEvents(session.workerOpId, {
      sinceEventId,
      lastEventId,
      signal: request.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      return NextResponse.json(
        { error: detail || 'Failed to proxy TTS playback event stream' },
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
      event: 'tts.playback.events_failed',
      msg: 'Failed to proxy TTS playback events',
      apiErrorMessage: 'Failed to proxy TTS playback events',
      normalize: { code: 'TTS_PLAYBACK_EVENTS_FAILED', errorClass: 'upstream' },
    });
  }
}

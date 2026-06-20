import { NextRequest, NextResponse } from 'next/server';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import { resolveTtsPlaybackPlanOperation } from '@/lib/server/tts/playback-plans';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ planId: string }> },
) {
  const { logger } = createRequestLogger({
    route: '/api/tts/playback/plans/[planId]/events',
    request,
  });
  try {
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json(
        { error: 'Compute worker is required for progressive TTS playback.' },
        { status: 503 },
      );
    }

    const { planId } = await context.params;
    const operation = await resolveTtsPlaybackPlanOperation(planId);
    if (!operation) return NextResponse.json({ error: 'Playback plan not found' }, { status: 404 });
    const scope = await resolveSegmentDocumentScope(request, operation.subject.documentId);
    if (scope instanceof Response) return scope;

    const lastEventId = request.headers.get('last-event-id');
    const sinceEventId = request.nextUrl.searchParams.get('sinceEventId') || lastEventId;
    const upstream = await getComputeWorkerClient().openOperationEvents(planId, {
      sinceEventId,
      lastEventId,
      signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      return NextResponse.json(
        { error: detail || 'Failed to proxy TTS playback plan event stream' },
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
      event: 'tts.playback_plan.events_failed',
      msg: 'Failed to proxy TTS playback plan events',
      apiErrorMessage: 'Failed to proxy TTS playback plan events',
      normalize: { code: 'TTS_PLAYBACK_PLAN_EVENTS_FAILED', errorClass: 'upstream' },
    });
  }
}

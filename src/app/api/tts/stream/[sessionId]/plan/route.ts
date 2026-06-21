import { GetObjectCommand } from '@aws-sdk/client-s3';
import { NextRequest, NextResponse } from 'next/server';
import { getS3Config, getS3ProxyClient } from '@/lib/server/storage/s3';
import { resolveTtsPlaybackSession } from '@/lib/server/tts/playback-sessions';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serve the worker-persisted canonical plan artifact for a playback session: the
 * full ordered segment list (segmentKey, text, locator) the worker generated
 * against. The client drives its UI (sidebar / sentence list / current index)
 * from this plan, while timing comes from the timeline endpoint.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { logger } = createRequestLogger({
    route: '/api/tts/stream/[sessionId]/plan',
    request,
  });
  try {
    const { sessionId } = await context.params;
    const session = await resolveTtsPlaybackSession(request, sessionId);
    if (session instanceof Response) return session;

    if (!session.planObjectKey) {
      // Plan not persisted yet — the worker writes it right after planning.
      return NextResponse.json({ error: 'Stream plan not ready' }, { status: 404 });
    }

    const cfg = getS3Config();
    const result = await getS3ProxyClient().send(new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: session.planObjectKey,
    }));
    const body = await result.Body?.transformToString();
    if (!body) {
      return NextResponse.json({ error: 'Stream plan not ready' }, { status: 404 });
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie, Authorization',
      },
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.playback.plan_failed',
      msg: 'Failed to load TTS playback plan',
      apiErrorMessage: 'Failed to load TTS playback plan',
      normalize: { code: 'TTS_PLAYBACK_PLAN_FAILED', errorClass: 'unknown' },
    });
  }
}

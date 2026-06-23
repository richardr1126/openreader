import { NextRequest, NextResponse } from 'next/server';
import {
  TTS_PLAYBACK_SESSION_TTL_MS,
  resolveTtsPlaybackSession,
} from '@/lib/server/tts/playback-sessions';
import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseOrdinal(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const ordinal = Number((value as Record<string, unknown>).ordinal);
  if (!Number.isFinite(ordinal)) return null;
  return Math.max(0, Math.floor(ordinal));
}

/**
 * Heartbeat the client's playback cursor for a playback session. The worker's
 * single generation job reads this to throttle how far ahead it generates while
 * the client is connected; when these stop arriving (cursor goes stale) the
 * worker switches to background-extent generation. Also rolls the session TTL so
 * an actively-read session does not expire mid-playback.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { logger } = createRequestLogger({
    route: '/api/tts/stream/[sessionId]/cursor',
    request,
  });
  try {
    const { sessionId } = await context.params;
    const session = await resolveTtsPlaybackSession(request, sessionId);
    if (session instanceof Response) return session;

    const ordinal = parseOrdinal(await request.json().catch(() => null));
    if (ordinal === null) {
      return NextResponse.json({ error: 'Invalid cursor ordinal' }, { status: 400 });
    }

    const now = Date.now();
    const expiresAt = now + TTS_PLAYBACK_SESSION_TTL_MS;
    await getComputeWorkerClient().updateTtsPlaybackCursor({
      sessionId: session.sessionId,
      ordinal,
      expiresAt,
    });

    return NextResponse.json({ sessionId: session.sessionId, cursorOrdinal: ordinal, expiresAt });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.playback.cursor_failed',
      msg: 'Failed to update TTS playback cursor',
      apiErrorMessage: 'Failed to update TTS playback cursor',
      normalize: { code: 'TTS_PLAYBACK_CURSOR_FAILED', errorClass: 'unknown' },
    });
  }
}

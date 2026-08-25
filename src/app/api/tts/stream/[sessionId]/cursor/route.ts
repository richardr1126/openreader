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

function parseCursorUpdate(value: unknown): { ordinal: number; playbackActive?: boolean } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const ordinal = Number(record.ordinal);
  if (!Number.isFinite(ordinal)) return null;
  if (record.playbackActive !== undefined && typeof record.playbackActive !== 'boolean') return null;
  return {
    ordinal: Math.max(0, Math.floor(ordinal)),
    ...(typeof record.playbackActive === 'boolean' ? { playbackActive: record.playbackActive } : {}),
  };
}

/**
 * Heartbeat the client's playback cursor for a playback session. The compute
 * worker uses this to enqueue bounded generation runs as playback advances.
 * Also rolls the session TTL so an actively-read session does not expire
 * mid-playback.
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

    const cursorUpdate = parseCursorUpdate(await request.json().catch(() => null));
    if (cursorUpdate === null) {
      return NextResponse.json({ error: 'Invalid cursor ordinal' }, { status: 400 });
    }

    const now = Date.now();
    const expiresAt = now + TTS_PLAYBACK_SESSION_TTL_MS;
    await getComputeWorkerClient().updateTtsPlaybackCursor({
      sessionId: session.sessionId,
      ordinal: cursorUpdate.ordinal,
      ...(cursorUpdate.playbackActive === undefined
        ? {}
        : { playbackActive: cursorUpdate.playbackActive }),
      expiresAt,
    });

    return NextResponse.json({
      sessionId: session.sessionId,
      cursorOrdinal: cursorUpdate.ordinal,
      playbackActive: cursorUpdate.playbackActive ?? session.playbackActive ?? true,
      expiresAt,
    });
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

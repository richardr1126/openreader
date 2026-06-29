import { NextRequest, NextResponse } from 'next/server';
import {
  listCompletedTtsPlaybackSegments,
  resolveTtsPlaybackSession,
} from '@/lib/server/tts/playback-sessions';
import {
  buildPlaybackGrid,
  readTtsPlaybackPlanArtifact,
} from '@/lib/server/tts/playback-plans';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import type { TTSSentenceAlignment } from '@/types/tts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseAlignment(value: string | null): TTSSentenceAlignment | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as TTSSentenceAlignment;
  } catch {
    return null;
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { logger } = createRequestLogger({
    route: '/api/tts/stream/[sessionId]/timeline',
    request,
  });
  try {
    const { sessionId } = await context.params;
    const session = await resolveTtsPlaybackSession(request, sessionId);
    if (session instanceof Response) return session;
    if (!session.planObjectKey) {
      throw new Error('TTS playback timeline requires a canonical plan artifact');
    }

    const segments = await listCompletedTtsPlaybackSegments(session);
    const completedSegments = new Map(segments.map((segment) => [segment.ordinal, {
      alignment: parseAlignment(segment.alignmentJson),
      updatedAt: segment.updatedAt,
    }]));
    const layout = buildPlaybackGrid({
      artifact: (await readTtsPlaybackPlanArtifact(session.planObjectKey)).artifact,
      settingsJson: session.settingsJson,
      completedDurations: new Map(segments.map((segment) => [segment.ordinal, segment.durationMs])),
      startOrdinal: 0,
      completedSegments,
    });

    return NextResponse.json({
      sessionId: session.sessionId,
      documentId: session.documentId,
      status: session.status,
      startOrdinal: 0,
      generationStartOrdinal: Math.max(0, Math.floor(session.generationStartOrdinal)),
      durationMs: layout.durationMs,
      segments: layout.segments,
    }, {
      headers: {
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie, Authorization',
      },
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.playback.timeline_failed',
      msg: 'Failed to build TTS playback timeline',
      apiErrorMessage: 'Failed to build TTS playback timeline',
      normalize: { code: 'TTS_PLAYBACK_TIMELINE_FAILED', errorClass: 'unknown' },
    });
  }
}

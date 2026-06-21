import { NextRequest, NextResponse } from 'next/server';
import {
  listCompletedTtsPlaybackSegments,
  resolveTtsPlaybackSession,
} from '@/lib/server/tts/playback-sessions';
import {
  buildSeekLayout,
  readTtsPlaybackPlanArtifact,
} from '@/lib/server/tts/playback-plans';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseAlignment(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
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
    const completedByOrdinal = new Map(segments.map((segment) => [segment.ordinal, segment]));
    const layout = buildSeekLayout({
      artifact: (await readTtsPlaybackPlanArtifact(session.planObjectKey)).artifact,
      settingsJson: session.settingsJson,
      completedDurations: new Map(segments.map((segment) => [segment.ordinal, segment.durationMs])),
      startOrdinal: Math.max(0, Math.floor(session.startOrdinal)),
    });
    const timeline = layout.slots.flatMap((slot) => {
      const segment = completedByOrdinal.get(slot.segmentIndex);
      if (!segment) return [];
      return [{
        ordinal: slot.segmentIndex,
        sourceSegmentIndex: slot.segmentIndex,
        segmentKey: slot.segmentKey,
        segmentId: segment.segmentId,
        startMs: slot.startMs,
        endMs: slot.endMs,
        durationMs: slot.durationMs,
        locator: slot.locator,
        alignment: parseAlignment(segment.alignmentJson),
        updatedAt: segment.updatedAt,
      }];
    });

    return NextResponse.json({
      sessionId: session.sessionId,
      documentId: session.documentId,
      status: session.status,
      startOrdinal: Math.max(0, Math.floor(session.startOrdinal)),
      durationMs: layout.durationMs,
      segments: timeline,
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

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

    const segments = await listCompletedTtsPlaybackSegments(session);
    const completedByOrdinal = new Map(segments.map((segment) => [segment.ordinal, segment]));
    const layout = session.planObjectKey
      ? buildSeekLayout({
          artifact: (await readTtsPlaybackPlanArtifact(session.planObjectKey)).artifact,
          settingsJson: session.settingsJson,
          completedDurations: new Map(segments.map((segment) => [segment.ordinal, segment.durationMs])),
          startOrdinal: Math.max(0, Math.floor(session.startOrdinal)),
        })
      : null;
    let cursorMs = 0;
    const timeline = layout
      ? layout.slots.flatMap((slot) => {
          const segment = completedByOrdinal.get(slot.segmentIndex);
          if (!segment) return [];
          return [{
            ordinal: segment.ordinal,
            sourceSegmentIndex: segment.sourceSegmentIndex,
            segmentKey: segment.segmentKey,
            segmentId: segment.segmentId,
            startMs: slot.startMs,
            endMs: slot.endMs,
            durationMs: segment.durationMs,
            locator: segment.locator,
            alignment: parseAlignment(segment.alignmentJson),
            updatedAt: segment.updatedAt,
          }];
        })
      : segments.map((segment) => {
          const startMs = cursorMs;
          cursorMs += segment.durationMs;
          return {
            ordinal: segment.ordinal,
            sourceSegmentIndex: segment.sourceSegmentIndex,
            segmentKey: segment.segmentKey,
            segmentId: segment.segmentId,
            startMs,
            endMs: cursorMs,
            durationMs: segment.durationMs,
            locator: segment.locator,
            alignment: parseAlignment(segment.alignmentJson),
            updatedAt: segment.updatedAt,
          };
        });
    const durationMs = layout?.durationMs ?? cursorMs;

    return NextResponse.json({
      sessionId: session.sessionId,
      documentId: session.documentId,
      status: session.status,
      startOrdinal: Math.max(0, Math.floor(session.startOrdinal)),
      durationMs,
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

import { NextRequest, NextResponse } from 'next/server';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import { resolveTtsPlaybackSession } from '@/lib/server/tts/playback-sessions';
import {
  buildSeekLayout,
  listCompletedDurationsForPlan,
  readTtsPlaybackPlanArtifact,
  resolveTtsPlaybackPlanOperation,
} from '@/lib/server/tts/playback-plans';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ planId: string }> },
) {
  const { logger } = createRequestLogger({
    route: '/api/tts/playback/plans/[planId]/seek-layout',
    request,
  });
  try {
    const { planId } = await context.params;
    const operation = await resolveTtsPlaybackPlanOperation(planId);
    if (!operation) return NextResponse.json({ error: 'Playback plan not found' }, { status: 404 });
    const subject = operation.subject;
    if (subject.kind !== 'tts_playback_plan') {
      return NextResponse.json({ error: 'Playback plan not found' }, { status: 404 });
    }

    const scope = await resolveSegmentDocumentScope(request, subject.documentId);
    if (scope instanceof Response) return scope;
    if (operation.status !== 'succeeded' || !operation.result?.planObjectKey) {
      return NextResponse.json({ error: 'Playback plan not ready' }, { status: 404 });
    }

    const { artifact } = await readTtsPlaybackPlanArtifact(operation.result.planObjectKey);
    if (artifact.storageUserId && artifact.storageUserId !== scope.storageUserId) {
      return NextResponse.json({ error: 'Playback plan scope mismatch' }, { status: 403 });
    }

    const sessionId = request.nextUrl.searchParams.get('sessionId')?.trim() || '';
    const session = sessionId ? await resolveTtsPlaybackSession(request, sessionId) : null;
    if (session instanceof Response) return session;
    const startOrdinal = session
      ? Math.max(0, Math.floor(session.startOrdinal))
      : Math.max(0, Math.floor(operation.result.startOrdinal));
    const settingsHash = session?.settingsHash || subject.settingsHash || artifact.settingsHash;
    const settingsJson = session?.settingsJson ?? artifact.settingsJson;
    const completedDurations = await listCompletedDurationsForPlan({
      storageUserId: scope.storageUserId,
      documentId: subject.documentId,
      documentVersion: artifact.documentVersion || scope.documentVersion,
      settingsHash,
    });
    const layout = buildSeekLayout({
      artifact,
      settingsJson,
      completedDurations,
      startOrdinal,
    });

    return NextResponse.json({
      planId,
      ...(session ? { sessionId: session.sessionId } : {}),
      startOrdinal,
      durationMs: layout.durationMs,
      segments: layout.slots.map((slot) => ({
        ordinal: slot.segmentIndex,
        startMs: slot.startMs,
        endMs: slot.endMs,
        generated: slot.generated,
        estimated: slot.estimated,
        locator: slot.locator,
        segmentKey: slot.segmentKey,
      })),
    }, {
      headers: {
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie, Authorization',
      },
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.playback_plan.seek_layout_failed',
      msg: 'Failed to build TTS playback seek layout',
      apiErrorMessage: 'Failed to build TTS playback seek layout',
      normalize: { code: 'TTS_PLAYBACK_SEEK_LAYOUT_FAILED', errorClass: 'unknown' },
    });
  }
}

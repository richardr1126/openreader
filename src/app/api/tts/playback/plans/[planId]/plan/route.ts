import { NextRequest, NextResponse } from 'next/server';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import {
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
    route: '/api/tts/playback/plans/[planId]/plan',
    request,
  });
  try {
    const { planId } = await context.params;
    const operation = await resolveTtsPlaybackPlanOperation(planId);
    if (!operation) return NextResponse.json({ error: 'Playback plan not found' }, { status: 404 });
    if (operation.subject.kind !== 'tts_playback_plan') {
      return NextResponse.json({ error: 'Playback plan not found' }, { status: 404 });
    }

    const scope = await resolveSegmentDocumentScope(request, operation.subject.documentId);
    if (scope instanceof Response) return scope;
    if (operation.status !== 'succeeded' || !operation.result?.planObjectKey) {
      return NextResponse.json({ error: 'Playback plan not ready' }, { status: 404 });
    }

    const { artifact, body } = await readTtsPlaybackPlanArtifact(operation.result.planObjectKey);
    if (artifact.storageUserId && artifact.storageUserId !== scope.storageUserId) {
      return NextResponse.json({ error: 'Playback plan scope mismatch' }, { status: 403 });
    }
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return NextResponse.json({
      ...parsed,
      planId,
      planObjectKey: operation.result.planObjectKey,
      planSignature: operation.result.planSignature,
      startOrdinal: operation.result.startOrdinal,
      plannedCount: operation.result.plannedCount,
    }, {
      headers: {
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie, Authorization',
      },
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.playback_plan.read_failed',
      msg: 'Failed to load TTS playback plan',
      apiErrorMessage: 'Failed to load TTS playback plan',
      normalize: { code: 'TTS_PLAYBACK_PLAN_READ_FAILED', errorClass: 'unknown' },
    });
  }
}

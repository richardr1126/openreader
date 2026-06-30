import { NextRequest, NextResponse } from 'next/server';
import {
  ComputeWorkerClient,
  isComputeWorkerAvailable,
} from '@/lib/server/compute-worker/client';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import {
  buildTtsPlaybackPlanningInput,
  parseTtsPlaybackRequestBody,
  toTtsPlaybackPlanRequest,
} from '@/lib/server/tts/playback-request';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const { logger } = createRequestLogger({
    route: '/api/tts/playback/plans',
    request,
  });
  try {
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json(
        { error: 'Compute worker is required for progressive TTS playback.' },
        { status: 503 },
      );
    }

    const parsed = parseTtsPlaybackRequestBody(await request.json().catch(() => null));
    if (!parsed) return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });

    const scope = await resolveSegmentDocumentScope(request, parsed.documentId);
    if (scope instanceof Response) return scope;

    const planningInput = await buildTtsPlaybackPlanningInput(parsed, scope);
    const planning = { ...planningInput.planning };
    delete planning.selectedOrdinal;
    const operation = await new ComputeWorkerClient().createTtsPlaybackPlanOperation(toTtsPlaybackPlanRequest({
      parsed,
      scope,
      ...planningInput,
      planning,
    }));

    const planId = operation.opId;
    return NextResponse.json({
      planId,
      operation,
      planUrl: `/api/tts/playback/plans/${encodeURIComponent(planId)}/plan`,
      seekLayoutUrl: `/api/tts/playback/plans/${encodeURIComponent(planId)}/seek-layout`,
    }, { status: 202 });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.playback_plan.create_failed',
      msg: 'Failed to create TTS playback plan',
      apiErrorMessage: 'Failed to create TTS playback plan',
      normalize: { code: 'TTS_PLAYBACK_PLAN_CREATE_FAILED', errorClass: 'unknown' },
    });
  }
}

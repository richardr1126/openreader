import { NextRequest, NextResponse } from 'next/server';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import {
  listCompletedTtsPlaybackSegments,
  resolveTtsPlaybackSession,
} from '@/lib/server/tts/playback-sessions';
import {
  buildPlaybackGrid,
  readTtsPlaybackPlanArtifact,
  resolveTtsPlaybackPlanOperation,
} from '@/lib/server/tts/playback-plans';
import {
  buildTtsPlaybackPlanningInput,
  parseTtsPlaybackRequestBody,
} from '@/lib/server/tts/playback-request';
import { createRequestLogger, errorToLog } from '@/lib/server/logger';
import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import { errorResponse } from '@/lib/server/errors/next-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ planId: string }> };

const START_ORDINAL = 0;

function seekLayoutResponse(input: {
  planId: string;
  session: { sessionId: string; generationStartOrdinal: number; status: string } | null;
  layout: ReturnType<typeof buildPlaybackGrid>;
}) {
  const { planId, session, layout } = input;
  return NextResponse.json({
    planId,
    ...(session ? { sessionId: session.sessionId } : {}),
    startOrdinal: START_ORDINAL,
    // The worker is the single source of truth for where playback begins: it
    // resolves this from stable spine coordinates (EPUB) / page (PDF) and writes
    // it back when it flips the session to `running`. The client follows it for
    // its current-segment index and initial audio seek. `status` lets the client
    // wait until that value is the worker-resolved one rather than the seed.
    generationStartOrdinal: session
      ? Math.max(0, Math.floor(session.generationStartOrdinal))
      : START_ORDINAL,
    status: session ? session.status : null,
    durationMs: layout.durationMs,
    segments: layout.segments,
  }, {
    headers: {
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie, Authorization',
    },
  });
}

function seekLayoutFailure(error: unknown, logger: ReturnType<typeof createRequestLogger>['logger']) {
  return errorResponse(error, {
    logger,
    event: 'tts.playback_plan.seek_layout_failed',
    msg: 'Failed to build TTS playback seek layout',
    apiErrorMessage: 'Failed to build TTS playback seek layout',
    normalize: { code: 'TTS_PLAYBACK_SEEK_LAYOUT_FAILED', errorClass: 'unknown' },
  });
}

/** Seek layout of a playback session's own plan artifact and cache scope. */
export async function GET(request: NextRequest, context: RouteContext) {
  const { logger } = createRequestLogger({
    route: '/api/tts/playback/plans/[planId]/seek-layout',
    request,
  });
  try {
    const { planId } = await context.params;
    const sessionId = request.nextUrl.searchParams.get('sessionId')?.trim() || '';
    if (!sessionId) {
      return NextResponse.json({ error: 'Seek layout requires a playback session' }, { status: 400 });
    }
    const session = await resolveTtsPlaybackSession(request, sessionId);
    if (session instanceof Response) return session;
    // A playback session owns the durable plan artifact it was created from, so
    // it stays seekable after the worker operation store is restarted or pruned.
    if (!session.planObjectKey) {
      throw new Error('TTS playback seek layout requires a canonical plan artifact');
    }

    const scope = await resolveSegmentDocumentScope(request, session.documentId);
    if (scope instanceof Response) return scope;
    const { artifact } = await readTtsPlaybackPlanArtifact(session.planObjectKey);
    if (artifact.storageUserId && artifact.storageUserId !== scope.storageUserId) {
      return NextResponse.json({ error: 'Playback plan scope mismatch' }, { status: 403 });
    }

    // Seek layout and timeline share the same whole-document cache view. The
    // worker bounds object-store reads while retaining every completed sidecar
    // it has discovered for this document/settings scope.
    const completedSegments = await listCompletedTtsPlaybackSegments(session);
    const layout = buildPlaybackGrid({
      artifact,
      settingsJson: session.settingsJson,
      completedDurations: new Map(completedSegments.map((segment) => [segment.ordinal, segment.durationMs])),
      startOrdinal: START_ORDINAL,
    });
    return seekLayoutResponse({ planId, session, layout });
  } catch (error) {
    return seekLayoutFailure(error, logger);
  }
}

/**
 * Seek layout before Play. The body is the playback request the client will
 * start its session with: the audio cache is keyed by those settings (only the
 * client resolves a provider's default voice), so the same planning input that
 * names the session's cache scope names the one read here.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { logger } = createRequestLogger({
    route: '/api/tts/playback/plans/[planId]/seek-layout',
    request,
  });
  try {
    const { planId } = await context.params;
    const parsed = parseTtsPlaybackRequestBody(await request.json().catch(() => null));
    if (!parsed) {
      return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
    }
    // Authenticate and check document ownership before revealing anything
    // about the plan id.
    const scope = await resolveSegmentDocumentScope(request, parsed.documentId);
    if (scope instanceof Response) return scope;
    const operation = await resolveTtsPlaybackPlanOperation(planId);
    if (!operation || operation.subject.kind !== 'tts_playback_plan') {
      return NextResponse.json({ error: 'Playback plan not found' }, { status: 404 });
    }
    if (operation.subject.documentId !== parsed.documentId) {
      return NextResponse.json({ error: 'Playback plan does not belong to this document' }, { status: 400 });
    }
    if (operation.status !== 'succeeded' || !operation.result?.planObjectKey) {
      return NextResponse.json({ error: 'Playback plan not ready' }, { status: 404 });
    }
    const planObjectKey = operation.result.planObjectKey;

    const { artifact } = await readTtsPlaybackPlanArtifact(planObjectKey);
    if (artifact.storageUserId && artifact.storageUserId !== scope.storageUserId) {
      return NextResponse.json({ error: 'Playback plan scope mismatch' }, { status: 403 });
    }

    const { settingsHash, settingsJson } = await buildTtsPlaybackPlanningInput(parsed, scope);
    const { segments: completedSegments } = await getComputeWorkerClient().listTtsPlaybackScopeCompletedSegments({
      storageUserId: scope.storageUserId,
      documentId: parsed.documentId,
      documentVersion: scope.documentVersion,
      settingsHash,
      planObjectKey,
    }).catch((error) => {
      // Cached ranges are an enhancement; the estimate alone keeps the
      // scrubber usable when the worker cannot be reached.
      logger.warn({
        event: 'tts.playback_plan.seek_layout_cache_read_failed',
        error: errorToLog(error),
      }, 'Cached playback durations were unavailable; showing estimates');
      return { segments: [] };
    });
    const layout = buildPlaybackGrid({
      artifact,
      settingsJson,
      completedDurations: new Map(completedSegments.map((segment) => [segment.ordinal, segment.durationMs])),
      startOrdinal: START_ORDINAL,
    });
    return seekLayoutResponse({ planId, session: null, layout });
  } catch (error) {
    return seekLayoutFailure(error, logger);
  }
}

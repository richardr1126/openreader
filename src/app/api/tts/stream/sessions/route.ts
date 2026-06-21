import { randomUUID } from 'crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@openreader/database';
import { ttsPlaybackSessions } from '@openreader/database/schema';
import {
  ComputeWorkerClient,
  getComputeWorkerPublicBaseUrl,
  isComputeWorkerAvailable,
} from '@/lib/server/compute-worker/client';
import { createTtsPlaybackToken } from '@openreader/tts/playback-token';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import {
  buildTtsPlaybackPlanningInput,
  parseTtsPlaybackRequestBody,
  validateTtsPlaybackStartLocation,
} from '@/lib/server/tts/playback-request';
import { TTS_PLAYBACK_SESSION_TTL_MS } from '@/lib/server/tts/playback-sessions';
import { getRuntimeConfig } from '@/lib/server/admin/settings';
import { TTS_PLAYBACK_AHEAD_WINDOW } from '@/types/tts';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getPlaybackTokenSecret(): string {
  const secret = process.env.TTS_PLAYBACK_TOKEN_SECRET?.trim();
  if (!secret) throw new Error('TTS_PLAYBACK_TOKEN_SECRET is required for worker-owned playback');
  return secret;
}

function buildWorkerAudioUrl(input: {
  sessionId: string;
  userId: string;
  storageUserId: string;
  documentId: string;
  expiresAt: number;
}): string {
  const token = createTtsPlaybackToken({
    sessionId: input.sessionId,
    userId: input.userId,
    storageUserId: input.storageUserId,
    documentId: input.documentId,
    exp: input.expiresAt,
  }, getPlaybackTokenSecret());
  const url = new URL(
    `/v1/tts-playback/${encodeURIComponent(input.sessionId)}/audio`,
    getComputeWorkerPublicBaseUrl(),
  );
  url.searchParams.set('token', token);
  return url.toString();
}

export async function POST(request: NextRequest) {
  const { logger } = createRequestLogger({
    route: '/api/tts/stream/sessions',
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
    if (!parsed) {
      return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
    }

    const scope = await resolveSegmentDocumentScope(request, parsed.documentId);
    if (scope instanceof Response) return scope;
    const startLocationError = validateTtsPlaybackStartLocation(parsed, scope);
    if (startLocationError) return NextResponse.json({ error: startLocationError }, { status: 400 });

    // The worker derives one position-independent canonical plan over the whole
    // document (whole book for EPUB) with absolute ordinals, reused across
    // sessions. The audio layout origin stays at ordinal 0. Generation start is
    // resolved by the worker from the stable document coordinate in `planning`;
    // queued rows are intentionally seeded at 0 until that worker-owned value is
    // published back to the session.
    // How far the worker keeps generating after the client disconnects, so
    // background playback survives JS suspending (admin-tunable).
    const { ttsPlaybackBackgroundExtent: backgroundExtent } = await getRuntimeConfig();
    const startOrdinal = 0;

    const now = Date.now();
    const expiresAt = now + TTS_PLAYBACK_SESSION_TTL_MS;
    const { settingsHash, settingsJson, planning } = await buildTtsPlaybackPlanningInput(parsed, scope);

    const sessionId = randomUUID();
    await db.insert(ttsPlaybackSessions).values({
      sessionId,
      userId: scope.userId,
      storageUserId: scope.storageUserId,
      documentId: parsed.documentId,
      documentVersion: scope.documentVersion,
      readerType: scope.readerType,
      status: 'queued',
      settingsHash,
      settingsJson,
      startOrdinal,
      generationStartOrdinal: 0,
      cursorOrdinal: 0,
      cursorUpdatedAt: now,
      ...(parsed.planObjectKey ? { planObjectKey: parsed.planObjectKey } : {}),
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    // Supersede this user's other active playback sessions so their (now
    // abandoned) worker jobs stop and release the worker's playback slot.
    await db
      .update(ttsPlaybackSessions)
      .set({ status: 'canceled', updatedAt: now })
      .where(and(
        eq(ttsPlaybackSessions.userId, scope.userId),
        ne(ttsPlaybackSessions.sessionId, sessionId),
        inArray(ttsPlaybackSessions.status, ['queued', 'running']),
      ));

    const operation = await new ComputeWorkerClient().createTtsPlaybackOperation({
      sessionId,
      userId: scope.userId,
      storageUserId: scope.storageUserId,
      documentId: parsed.documentId,
      documentVersion: scope.documentVersion,
      readerType: scope.readerType,
      settingsHash,
      settingsJson,
      ...(parsed.planObjectKey ? { planObjectKey: parsed.planObjectKey } : {}),
      // One forward-generation job, throttled to a window ahead of the client's
      // playback cursor; on disconnect it continues to the background extent.
      aheadWindow: TTS_PLAYBACK_AHEAD_WINDOW,
      backgroundExtent,
      planning,
    });

    await db
      .update(ttsPlaybackSessions)
      .set({
        workerOpId: operation.opId,
        status: operation.status,
        updatedAt: Date.now(),
      })
      .where(eq(ttsPlaybackSessions.sessionId, sessionId));

    const responseBase = {
      sessionId,
      operation,
      timelineUrl: `/api/tts/stream/${encodeURIComponent(sessionId)}/timeline`,
      planUrl: `/api/tts/stream/${encodeURIComponent(sessionId)}/plan`,
      eventsUrl: `/api/tts/stream/${encodeURIComponent(sessionId)}/events`,
      seekLayoutUrl: parsed.planId
        ? `/api/tts/playback/plans/${encodeURIComponent(parsed.planId)}/seek-layout?sessionId=${encodeURIComponent(sessionId)}`
        : '',
      expiresAt,
    };
    return NextResponse.json({
      ...responseBase,
      audioUrl: buildWorkerAudioUrl({
        sessionId,
        userId: scope.userId,
        storageUserId: scope.storageUserId,
        documentId: parsed.documentId,
        expiresAt,
      }),
    }, { status: 202 });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.playback.session_create_failed',
      msg: 'Failed to create TTS playback session',
      apiErrorMessage: 'Failed to create TTS playback session',
      normalize: { code: 'TTS_PLAYBACK_SESSION_CREATE_FAILED', errorClass: 'unknown' },
    });
  }
}

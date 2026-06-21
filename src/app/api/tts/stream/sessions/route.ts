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
import { buildTtsSegmentSettingsHash, buildTtsSegmentSettingsJson } from '@openreader/tts/segments';
import { createTtsPlaybackToken } from '@openreader/tts/playback-token';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import { getDocumentSkipBlockKinds } from '@/lib/server/tts/document-skip-kinds';
import { TTS_PLAYBACK_SESSION_TTL_MS } from '@/lib/server/tts/playback-sessions';
import { getRuntimeConfig } from '@/lib/server/admin/settings';
import { TTS_PLAYBACK_AHEAD_WINDOW } from '@/types/tts';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { isTtsProviderType } from '@openreader/tts/provider-catalog';
import { normalizeLanguageTag } from '@openreader/tts/language';
import type { TTSSegmentSettings } from '@/types/client';

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

function parseSettings(value: unknown): TTSSegmentSettings | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.providerRef !== 'string') return null;
  if (!isTtsProviderType(rec.providerType)) return null;
  if (typeof rec.ttsModel !== 'string') return null;
  if (typeof rec.voice !== 'string') return null;
  if (!Number.isFinite(Number(rec.nativeSpeed))) return null;
  if (rec.ttsInstructions !== undefined && typeof rec.ttsInstructions !== 'string') return null;
  if (rec.language !== undefined && typeof rec.language !== 'string') return null;
  return {
    providerRef: rec.providerRef,
    providerType: rec.providerType,
    ttsModel: rec.ttsModel,
    voice: rec.voice,
    nativeSpeed: Number(rec.nativeSpeed),
    ...(typeof rec.ttsInstructions === 'string' ? { ttsInstructions: rec.ttsInstructions } : {}),
    ...(typeof rec.language === 'string' ? { language: normalizeLanguageTag(rec.language) } : {}),
  };
}

function parseBody(value: unknown): {
  documentId: string;
  settings: TTSSegmentSettings;
  startLocation: { page?: number; spineIndex?: number };
  maxBlockLength?: number;
  language?: string;
  startSegmentKey?: string;
  startText?: string;
} | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  const documentId = typeof rec.documentId === 'string' ? rec.documentId.trim().toLowerCase() : '';
  const settings = parseSettings(rec.settings);
  if (!documentId || !settings) return null;

  const startRec = rec.startLocation && typeof rec.startLocation === 'object'
    ? rec.startLocation as Record<string, unknown>
    : null;
  const page = Number.isFinite(Number(startRec?.page))
    ? Math.max(1, Math.floor(Number(startRec?.page)))
    : undefined;
  const spineIndex = Number.isFinite(Number(startRec?.spineIndex))
    ? Math.max(0, Math.floor(Number(startRec?.spineIndex)))
    : undefined;

  // `planning` is now limited to segmentation knobs; reading text is derived
  // server-side from the document (worker-owned planning).
  const planningRec = rec.planning && typeof rec.planning === 'object'
    ? rec.planning as Record<string, unknown>
    : null;
  const maxBlockLength = Number.isFinite(Number(planningRec?.maxBlockLength))
    ? Math.max(1, Math.floor(Number(planningRec?.maxBlockLength)))
    : undefined;
  const language = typeof planningRec?.language === 'string'
    ? normalizeLanguageTag(planningRec.language)
    : undefined;
  const startSegmentKey = typeof rec.startSegmentKey === 'string' && rec.startSegmentKey.trim()
    ? rec.startSegmentKey.trim()
    : undefined;
  const startText = typeof rec.startText === 'string' && rec.startText.trim()
    ? rec.startText.trim()
    : undefined;

  return {
    documentId,
    settings,
    startLocation: {
      ...(page ? { page } : {}),
      ...(spineIndex !== undefined ? { spineIndex } : {}),
    },
    ...(maxBlockLength ? { maxBlockLength } : {}),
    ...(language ? { language } : {}),
    ...(startSegmentKey ? { startSegmentKey } : {}),
    ...(startText ? { startText } : {}),
  };
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

    const parsed = parseBody(await request.json().catch(() => null));
    if (!parsed) {
      return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
    }

    const scope = await resolveSegmentDocumentScope(request, parsed.documentId);
    if (scope instanceof Response) return scope;

    // PDF/HTML plan the whole forward document up front so playback is seamless
    // across page boundaries (one session, audio throttled to a window ahead of
    // the playback cursor). EPUB keeps its per-section plan + chapter-handoff
    // machinery; it still benefits from windowed generation within a chapter.
    const planExtent = scope.readerType === 'epub' ? 'section' : 'document';
    // How far the worker keeps generating after the client disconnects, so
    // background playback survives JS suspending (admin-tunable).
    const { ttsPlaybackBackgroundExtent: backgroundExtent } = await getRuntimeConfig();
    const skipBlockKinds = scope.readerType === 'pdf'
      ? await getDocumentSkipBlockKinds(parsed.documentId, scope.storageUserId)
      : [];
    const isPlainText = scope.readerType === 'html'
      ? scope.documentName.toLowerCase().endsWith('.txt')
      : false;
    const startPage = scope.readerType === 'pdf'
      ? (parsed.startLocation.page ?? 1)
      : undefined;
    const startSpineIndex = scope.readerType === 'epub'
      ? (parsed.startLocation.spineIndex ?? 0)
      : undefined;
    // Playback ordinals are session-local media indexes. The document start
    // position belongs in planning.documentSource below.
    const startOrdinal = 0;

    const now = Date.now();
    const expiresAt = now + TTS_PLAYBACK_SESSION_TTL_MS;
    const settingsHash = buildTtsSegmentSettingsHash(parsed.settings);
    const settingsJson = buildTtsSegmentSettingsJson(parsed.settings);

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
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    // Supersede this user's other active playback sessions so their (now
    // abandoned) worker jobs stop and release the worker's concurrency slot —
    // otherwise a refreshed/closed session keeps generating in the background and
    // starves the new one. The worker's cursor/status poll picks this up within
    // ~500ms and exits gracefully.
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
      startOrdinal,
      // One forward-generation job, throttled to a window ahead of the client's
      // playback cursor; on disconnect it continues to the background extent.
      aheadWindow: TTS_PLAYBACK_AHEAD_WINDOW,
      backgroundExtent,
      planning: {
        ...(parsed.maxBlockLength ? { maxBlockLength: parsed.maxBlockLength } : {}),
        ...(parsed.language ? { language: parsed.language } : {}),
        ...(parsed.startSegmentKey ? { startSegmentKey: parsed.startSegmentKey } : {}),
        ...(parsed.startText ? { startText: parsed.startText } : {}),
        // PDF segments stay within blocks/pages, matching the client preview.
        enforceSourceBoundaries: scope.readerType === 'pdf',
        documentSource: {
          namespace: scope.testNamespace,
          skipBlockKinds,
          extent: planExtent,
          ...(startPage !== undefined ? { startPage } : {}),
          ...(startSpineIndex !== undefined ? { startSpineIndex } : {}),
          isPlainText,
        },
      },
    });

    await db
      .update(ttsPlaybackSessions)
      .set({
        workerOpId: operation.opId,
        status: operation.status,
        updatedAt: Date.now(),
      })
      .where(eq(ttsPlaybackSessions.sessionId, sessionId));

    return NextResponse.json({
      sessionId,
      operation,
      audioUrl: buildWorkerAudioUrl({
        sessionId,
        userId: scope.userId,
        storageUserId: scope.storageUserId,
        documentId: parsed.documentId,
        expiresAt,
      }),
      timelineUrl: `/api/tts/stream/${encodeURIComponent(sessionId)}/timeline`,
      planUrl: `/api/tts/stream/${encodeURIComponent(sessionId)}/plan`,
      eventsUrl: `/api/tts/stream/${encodeURIComponent(sessionId)}/events`,
      expiresAt,
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

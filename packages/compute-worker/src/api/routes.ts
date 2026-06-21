import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '@openreader/database';
import { ttsPlaybackSessions, ttsSegmentEntries, ttsSegmentVariants } from '@openreader/database/schema';
import { verifyTtsPlaybackToken } from '@openreader/tts/playback-token';
import { encodeSseFrame } from '../operations';
import type {
  PdfLayoutJobResult,
  WorkerJobTiming,
  WorkerOperationEvent,
  WorkerOperationRequest,
  WorkerOperationState,
  TtsPlaybackJobResult,
  TtsPlaybackPlanJobResult,
} from '../operations/contracts';
import { hashOpKey } from '../infrastructure/nats-adapters';
import type { StreamedOperationState } from '../operations/recovery';
import type { ReconciliationStateStore } from '../operations/reconciliation';
import { parsedPdfArtifactKey } from '../storage/artifact-addressing';
import { getCbrSilenceSecond } from '@openreader/tts/audio-format';
import {
  buildByteLayout,
  locateByte,
  parseRangeHeader,
  type PlanSlotInput,
} from './playback-audio-layout';
import {
  buildPdfOperationKey,
  buildTtsPlaybackOperationKey,
  buildTtsPlaybackPlanOperationKey,
} from '../operations/keys';
import { computePlaybackPlanSignature } from '../jobs/handlers';
import { requireEnv } from '../infrastructure/config';
import type { ArtifactStorage } from '../infrastructure/storage';
import { toComputeOperation, type ComputeOperationEvent } from './compute-operation';
import {
  apiErrorResponseSchema,
  jsonSchema,
  operationEventsQuerySchema,
  operationParamsSchema,
  pdfLayoutResolutionSchema,
  pdfOperationCreateSchema,
  pdfResolveSchema,
  computeOperationSchema,
  ttsPlaybackPlanOperationCreateSchema,
  ttsPlaybackOperationCreateSchema,
} from './schemas';

const OP_EVENTS_KEEPALIVE_MS = 15_000;
const OP_EVENTS_RECONNECT_HINT_MS = 120_000;
const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

interface OperationEventStreamLike {
  subscribe(input: {
    opId: string;
    sinceEventId?: number;
    onEvent: (event: WorkerOperationEvent<PdfLayoutJobResult | TtsPlaybackJobResult | TtsPlaybackPlanJobResult>) => void | Promise<void>;
    onError?: (error: unknown) => void;
  }): Promise<() => void>;
}

interface OperationStateStoreLike extends ReconciliationStateStore {}

interface OrchestratorLike {
  enqueueOrReuse(request: WorkerOperationRequest): Promise<WorkerOperationState>;
  markRunning(input: {
    opId: string;
    startedAt?: number;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
  markProgress(input: {
    opId: string;
    progress: WorkerOperationState['progress'];
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
  markSucceeded(input: {
    opId: string;
    result: unknown;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
  markFailed(input: {
    opId: string;
    error: { message: string; code?: string } | string;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
  markFailedIfUnchanged?(input: {
    current: StreamedOperationState;
    expectedRevision: number;
    error: { message: string; code?: string } | string;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
}

export interface ComputeWorkerRouteDeps {
  orchestrator: OrchestratorLike;
  operationStateStore: OperationStateStoreLike;
  operationEventStream: OperationEventStreamLike;
  artifactExists?: (key: string) => Promise<boolean>;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function isTerminalStatus(status: import('../operations/contracts').WorkerJobState): boolean {
  return status === 'succeeded' || status === 'failed';
}

export function registerComputeWorkerRoutes(input: {
  app: FastifyInstance;
  deps: ComputeWorkerRouteDeps;
  storage: ArtifactStorage;
  s3Prefix: string;
  ensureOrphanedOpRecovery: () => Promise<void>;
  getOpState: (opId: string) => Promise<StreamedOperationState | null>;
  getNatsConnected: () => boolean;
  releaseHttp: (request: FastifyRequest) => void;
  markActivity: (reason: string) => void;
  onActiveSseChanged: (delta: number) => void;
}) {
  const {
    app,
    deps,
    storage,
    s3Prefix,
    ensureOrphanedOpRecovery,
    getOpState,
    getNatsConnected,
    releaseHttp,
    markActivity,
    onActiveSseChanged,
  } = input;

  type PlaybackSessionRow = {
    sessionId: string;
    userId: string;
    storageUserId: string;
    documentId: string;
    documentVersion: number;
    readerType: string;
    status: string;
    settingsHash: string;
    settingsJson: unknown;
    startOrdinal: number;
    generationStartOrdinal: number;
    cursorOrdinal: number;
    planObjectKey: string | null;
    expiresAt: number;
  };

  type CompletedPlaybackSegment = {
    ordinal: number;
    audioKey: string;
    durationMs: number;
  };

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const stripId3Tag = (bytes: Buffer): Buffer => {
    if (bytes.length < 10 || bytes.subarray(0, 3).toString('ascii') !== 'ID3') return bytes;
    const size =
      ((bytes[6] & 0x7f) << 21)
      | ((bytes[7] & 0x7f) << 14)
      | ((bytes[8] & 0x7f) << 7)
      | (bytes[9] & 0x7f);
    const end = 10 + size;
    return end > 0 && end < bytes.length ? bytes.subarray(end) : bytes;
  };

  const readPlaybackSession = async (sessionId: string): Promise<PlaybackSessionRow | null> => {
    const rows = (await db
      .select({
        sessionId: ttsPlaybackSessions.sessionId,
        userId: ttsPlaybackSessions.userId,
        storageUserId: ttsPlaybackSessions.storageUserId,
        documentId: ttsPlaybackSessions.documentId,
        documentVersion: ttsPlaybackSessions.documentVersion,
        readerType: ttsPlaybackSessions.readerType,
        status: ttsPlaybackSessions.status,
        settingsHash: ttsPlaybackSessions.settingsHash,
        settingsJson: ttsPlaybackSessions.settingsJson,
        startOrdinal: ttsPlaybackSessions.startOrdinal,
        generationStartOrdinal: ttsPlaybackSessions.generationStartOrdinal,
        cursorOrdinal: ttsPlaybackSessions.cursorOrdinal,
        planObjectKey: ttsPlaybackSessions.planObjectKey,
        expiresAt: ttsPlaybackSessions.expiresAt,
      })
      .from(ttsPlaybackSessions)
      .where(eq(ttsPlaybackSessions.sessionId, sessionId))
      .limit(1)) as PlaybackSessionRow[];
    return rows[0] ?? null;
  };

  const readCompletedPlaybackSegment = async (
    session: PlaybackSessionRow,
    ordinal: number,
  ): Promise<CompletedPlaybackSegment | null> => {
    const rows = (await db
      .select({
        ordinal: ttsSegmentEntries.segmentIndex,
        audioKey: ttsSegmentVariants.audioKey,
        durationMs: ttsSegmentVariants.durationMs,
      })
      .from(ttsSegmentEntries)
      .innerJoin(ttsSegmentVariants, and(
        eq(ttsSegmentVariants.segmentEntryId, ttsSegmentEntries.segmentEntryId),
        eq(ttsSegmentVariants.userId, ttsSegmentEntries.userId),
      ))
      .where(and(
        eq(ttsSegmentEntries.userId, session.storageUserId),
        eq(ttsSegmentEntries.documentId, session.documentId),
        eq(ttsSegmentEntries.documentVersion, session.documentVersion),
        eq(ttsSegmentEntries.segmentIndex, ordinal),
        eq(ttsSegmentVariants.settingsHash, session.settingsHash),
        eq(ttsSegmentVariants.status, 'completed'),
        gt(ttsSegmentVariants.audioKey, ''),
      ))
      .limit(1)) as Array<{ ordinal: number; audioKey: string | null; durationMs: number | null }>;
    const row = rows[0];
    if (!row?.audioKey) return null;
    return {
      ordinal: Number(row.ordinal),
      audioKey: row.audioKey,
      durationMs: Math.max(1, Number(row.durationMs ?? 1000)),
    };
  };

  const updatePlaybackCursor = async (sessionId: string, ordinal: number): Promise<void> => {
    const now = Date.now();
    await db
      .update(ttsPlaybackSessions)
      .set({
        cursorOrdinal: Math.max(0, Math.floor(ordinal)),
        cursorUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(ttsPlaybackSessions.sessionId, sessionId));
  };

  // Generous base speaking rate (ms of audio per source character) for *estimating*
  // the not-yet-generated tail. Biased high so the advertised Content-Length stays
  // ≥ the real byte total (the difference is filled with valid CBR silence, never
  // truncated). Scaled by the voice's native speed so fast voices don't get a wildly
  // over-long scrub bar.
  const ESTIMATE_MS_PER_CHAR_BASE = 78;

  const estimateRateForSession = (session: PlaybackSessionRow): number => {
    const speedRaw = (session.settingsJson as { nativeSpeed?: unknown } | null)?.nativeSpeed;
    const speed = Number(speedRaw);
    const clamped = Number.isFinite(speed) && speed > 0 ? Math.min(3, Math.max(0.5, speed)) : 1;
    return ESTIMATE_MS_PER_CHAR_BASE / clamped;
  };

  // Cache parsed plans by object key. Plans are content-addressed (the key encodes
  // doc + version + reader + segmentation signature), so a given key is immutable —
  // caching avoids re-reading and re-parsing a multi-MB whole-book plan on every
  // range request (Safari issues several), which would otherwise block the event
  // loop. Bounded to the few most-recently-used plans.
  const planSegmentsCache = new Map<string, Array<{ segmentIndex: number; text: string }>>();
  const PLAN_CACHE_MAX = 4;

  // Read the whole position-independent plan (segment index + text) from storage.
  const readPlanSegments = async (
    planObjectKey: string,
  ): Promise<Array<{ segmentIndex: number; text: string }> | null> => {
    const cached = planSegmentsCache.get(planObjectKey);
    if (cached) return cached;
    try {
      const bytes = await storage.readObject(planObjectKey);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
        segments?: Array<{ segmentIndex?: unknown; text?: unknown }>;
      };
      if (!Array.isArray(parsed.segments)) return null;
      const out: Array<{ segmentIndex: number; text: string }> = [];
      for (const row of parsed.segments) {
        const segmentIndex = Number(row.segmentIndex);
        const text = typeof row.text === 'string' ? row.text : '';
        if (Number.isFinite(segmentIndex) && text) {
          out.push({ segmentIndex: Math.max(0, Math.floor(segmentIndex)), text });
        }
      }
      if (planSegmentsCache.size >= PLAN_CACHE_MAX) {
        const oldest = planSegmentsCache.keys().next().value;
        if (oldest !== undefined) planSegmentsCache.delete(oldest);
      }
      planSegmentsCache.set(planObjectKey, out);
      return out;
    } catch {
      return null;
    }
  };

  // Map of ordinal → exact probed durationMs for every completed segment of this
  // session's document/version/settings (drives exact byte offsets for seeking).
  const listCompletedDurations = async (
    session: PlaybackSessionRow,
  ): Promise<Map<number, number>> => {
    const rows = (await db
      .select({
        ordinal: ttsSegmentEntries.segmentIndex,
        durationMs: ttsSegmentVariants.durationMs,
      })
      .from(ttsSegmentEntries)
      .innerJoin(ttsSegmentVariants, and(
        eq(ttsSegmentVariants.segmentEntryId, ttsSegmentEntries.segmentEntryId),
        eq(ttsSegmentVariants.userId, ttsSegmentEntries.userId),
      ))
      .where(and(
        eq(ttsSegmentEntries.userId, session.storageUserId),
        eq(ttsSegmentEntries.documentId, session.documentId),
        eq(ttsSegmentEntries.documentVersion, session.documentVersion),
        eq(ttsSegmentVariants.settingsHash, session.settingsHash),
        eq(ttsSegmentVariants.status, 'completed'),
        gt(ttsSegmentVariants.audioKey, ''),
      ))) as Array<{ ordinal: number; durationMs: number | null }>;
    const map = new Map<number, number>();
    for (const row of rows) {
      map.set(Number(row.ordinal), Math.max(1, Number(row.durationMs ?? 1000)));
    }
    return map;
  };

  app.get('/health/live', {
    schema: {
      security: [],
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
    },
  }, async () => ({ ok: true }));

  app.get('/health/ready', {
    schema: {
      security: [],
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, natsConnected: { type: 'boolean' } },
          required: ['ok', 'natsConnected'],
        },
      },
    },
  }, async () => ({ ok: true, natsConnected: getNatsConnected() }));

  app.get('/v1/tts-playback/:sessionId/audio', {
    schema: {
      security: [],
      params: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
      querystring: {
        type: 'object',
        properties: { token: { type: 'string' } },
        required: ['token'],
      },
      response: {
        200: { type: 'string', description: 'Progressive MP3 audio stream' },
        206: { type: 'string', description: 'Progressive MP3 audio byte range' },
        400: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
        409: errorResponseSchema,
        416: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const query = request.query as { token?: string };
    const sessionId = params.sessionId?.trim() ?? '';
    if (!sessionId || !query.token) {
      reply.code(400);
      return { error: 'Missing playback session id or token' };
    }

    let tokenPayload: ReturnType<typeof verifyTtsPlaybackToken>;
    try {
      tokenPayload = verifyTtsPlaybackToken(query.token, requireEnv('TTS_PLAYBACK_TOKEN_SECRET'));
    } catch (error) {
      reply.code(403);
      return { error: toErrorMessage(error) };
    }
    if (tokenPayload.sessionId !== sessionId) {
      reply.code(403);
      return { error: 'Playback token session mismatch' };
    }

    const initialSession = await readPlaybackSession(sessionId);
    if (!initialSession) {
      reply.code(404);
      return { error: 'Playback session not found' };
    }
    if (
      initialSession.userId !== tokenPayload.userId
      || initialSession.storageUserId !== tokenPayload.storageUserId
      || initialSession.documentId !== tokenPayload.documentId
    ) {
      reply.code(403);
      return { error: 'Playback token scope mismatch' };
    }

    let closed = false;
    request.raw.on('close', () => {
      closed = true;
      app.log.info({ sessionId }, 'tts.playback.audio.client_closed');
    });

    const startedAt = Date.now();

    // Resolve a snapshot of the stream layout before sending headers: we need a
    // stable total byte size for Content-Length / seeking. The total is a
    // deterministic char-based estimate over the whole window (independent of how
    // much is generated, so it never changes between range requests), while the
    // byte→ordinal map uses exact durations where generated so seeks land on the
    // correct segment. CBR makes both linear (see STREAM_AUDIO_PROFILE).
    type Layout = { totalBytes: number; slots: ReturnType<typeof buildByteLayout>['slots'] };
    type Resolved =
      | { kind: 'ok'; total: number; mapLayout: Layout }
      | { kind: 'error'; code: 400 | 404 | 409 | 503; message: string };

    const resolveLayout = async (): Promise<Resolved> => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (closed) return { kind: 'error', code: 409, message: 'Client disconnected' };
        const session = await readPlaybackSession(sessionId);
        if (!session) return { kind: 'error', code: 404, message: 'Playback session not found' };
        if (Date.now() > session.expiresAt) {
          return { kind: 'error', code: 404, message: 'Playback session expired' };
        }
        if (session.status !== 'queued' && session.status !== 'running' && session.status !== 'succeeded') {
          return { kind: 'error', code: 409, message: 'Playback session is no longer active' };
        }
        if (session.planObjectKey) {
          const planSegments = await readPlanSegments(session.planObjectKey);
          if (planSegments) {
            const startOrdinal = Math.max(0, Math.floor(session.startOrdinal));
            const completed = await listCompletedDurations(session);
            const estimateRate = estimateRateForSession(session);
            const mapSlots: PlanSlotInput[] = planSegments.map((segment) => ({
              segmentIndex: segment.segmentIndex,
              text: segment.text,
              durationMs: completed.get(segment.segmentIndex) ?? null,
            }));
            const totalSlots: PlanSlotInput[] = planSegments.map((segment) => ({
              segmentIndex: segment.segmentIndex,
              text: segment.text,
              durationMs: null, // pure estimate → stable across requests
            }));
            const mapLayout = buildByteLayout(mapSlots, startOrdinal, estimateRate);
            const total = buildByteLayout(totalSlots, startOrdinal, estimateRate).totalBytes;
            return { kind: 'ok', total, mapLayout };
          }
        }
        if (Date.now() > deadline) {
          return { kind: 'error', code: 503, message: 'Playback plan not ready' };
        }
        markActivity('tts_playback_audio_wait');
        await sleep(250);
      }
    };

    const resolved = await resolveLayout();
    if (resolved.kind === 'error') {
      reply.code(resolved.code);
      return { error: resolved.message };
    }
    const { total, mapLayout } = resolved;

    const rangeHeaderRaw = request.headers.range;
    const rangeHeader = Array.isArray(rangeHeaderRaw) ? rangeHeaderRaw[0] : rangeHeaderRaw;
    const parsedRange = parseRangeHeader(rangeHeader, total);

    reply.header('Content-Type', 'audio/mpeg');
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Accel-Buffering', 'no');
    reply.header('Accept-Ranges', 'bytes');

    if (parsedRange === 'unsatisfiable') {
      reply.code(416);
      reply.header('Content-Range', `bytes */${total}`);
      return { error: 'Requested range not satisfiable' };
    }

    // null (no Range) and 'invalid' (malformed/multi-range) both serve the full body.
    const range = parsedRange && parsedRange !== 'invalid'
      ? parsedRange
      : { start: 0, end: Math.max(0, total - 1) };

    if (parsedRange && parsedRange !== 'invalid') {
      reply.code(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
    } else {
      reply.code(200);
    }
    reply.header('Content-Length', String(total === 0 ? 0 : range.end - range.start + 1));

    // Stream the requested byte window: real (gapless, ID3-stripped) segment audio
    // from the mapped position, waiting for the worker to generate pending segments,
    // then valid CBR silence to pad up to the advertised length (never truncated).
    const streamRange = async function* (): AsyncGenerator<Buffer> {
      if (total === 0) return;
      const need = range.end - range.start + 1;
      if (need <= 0) return;
      let sent = 0;
      const startLoc = locateByte(mapLayout, range.start);
      let slotIdx = startLoc ? startLoc.slotIndex : mapLayout.slots.length;
      let skipWithin = startLoc ? startLoc.offsetWithin : 0;
      let wroteFirstByte = false;
      let silenceUnit: Buffer | null = null;

      const streamSilence = async function* (byteCount: number): AsyncGenerator<Buffer> {
        let written = 0;
        while (written < byteCount && !closed) {
          if (silenceUnit === null) {
            silenceUnit = await getCbrSilenceSecond().catch(() => Buffer.alloc(0));
          }
          const remaining = byteCount - written;
          let chunk: Buffer;
          if (silenceUnit.length > 0) {
            chunk = remaining >= silenceUnit.length ? silenceUnit : silenceUnit.subarray(0, remaining);
          } else {
            chunk = Buffer.alloc(Math.min(remaining, 65536)); // ffmpeg unavailable fallback
          }
          yield chunk;
          written += chunk.length;
        }
      };

      for (; slotIdx < mapLayout.slots.length && sent < need; slotIdx += 1) {
        const slot = mapLayout.slots[slotIdx];
        const ordinal = slot.segmentIndex;
        let audioKey: string | null = null;
        let paddedMissingPrefix = false;
        for (;;) {
          if (closed) return;
          const session = await readPlaybackSession(sessionId);
          if (!session || Date.now() > session.expiresAt) return;
          if (session.status !== 'queued' && session.status !== 'running' && session.status !== 'succeeded') {
            return;
          }
          const seg = await readCompletedPlaybackSegment(session, ordinal);
          if (seg) {
            audioKey = seg.audioKey;
            break;
          }
          if (ordinal < session.generationStartOrdinal) {
            const room = need - sent;
            const silenceBytes = Math.max(0, Math.min(room, slot.byteLength - skipWithin));
            if (silenceBytes > 0) {
              for await (const chunk of streamSilence(silenceBytes)) {
                yield chunk;
                sent += chunk.length;
              }
            }
            skipWithin = 0;
            paddedMissingPrefix = true;
            break;
          }
          if (session.status === 'succeeded') {
            // Generation finished but this ordinal has no audio (gap / end of the
            // generated extent): stop pulling real audio and pad the rest.
            app.log.info({ sessionId, ordinal }, 'tts.playback.audio.stopped_at_gap');
            break;
          }
          markActivity('tts_playback_audio_wait');
          await sleep(400);
        }
        if (!audioKey) {
          if (paddedMissingPrefix) continue;
          break;
        }

        await updatePlaybackCursor(sessionId, ordinal).catch((error) => {
          app.log.warn({ sessionId, ordinal, error: toErrorMessage(error) }, 'tts.playback.cursor_update_failed');
        });
        let bytes = stripId3Tag(Buffer.from(await storage.readObject(audioKey)));
        if (skipWithin > 0) {
          bytes = bytes.subarray(Math.min(skipWithin, bytes.length));
          skipWithin = 0;
        }
        const room = need - sent;
        if (bytes.length > room) bytes = bytes.subarray(0, room);
        if (bytes.length > 0) {
          if (!wroteFirstByte) {
            wroteFirstByte = true;
            app.log.info({ sessionId, ordinal, firstByteMs: Date.now() - startedAt }, 'tts.playback.audio.first_byte');
          }
          markActivity('tts_playback_audio_segment');
          yield bytes;
          sent += bytes.length;
        }
      }

      // Pad up to the advertised length with valid CBR silence — streamed in bounded
      // chunks (reusing the cached ~1s buffer). The pad can be large for a long
      // document (the advertised total is a whole-document estimate), so it must
      // never be materialized as a single buffer.
      if (sent < need && !closed) {
        for await (const chunk of streamSilence(need - sent)) {
          yield chunk;
          sent += chunk.length;
        }
      }
    };

    return Readable.from(streamRange());
  });

  app.post('/v1/pdf-layout/operations', {
    schema: {
      body: jsonSchema(pdfOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = pdfOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }

    const requestOp: WorkerOperationRequest = {
      kind: 'pdf_layout',
      opKey: buildPdfOperationKey(parsed.data),
      payload: {
        documentId: parsed.data.documentId,
        namespace: parsed.data.namespace,
        documentObjectKey: parsed.data.documentObjectKey,
      },
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
    reply.code(202);
    return toComputeOperation(op);
  });

  app.post('/v1/tts-playback/operations', {
    schema: {
      body: jsonSchema(ttsPlaybackOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }

    const requestOp: WorkerOperationRequest = {
      kind: 'tts_playback',
      opKey: buildTtsPlaybackOperationKey(parsed.data),
      payload: parsed.data,
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
    app.log.info({
      kind: requestOp.kind,
      opId: op.opId,
      jobId: op.jobId,
      status: op.status,
      opKeyHash: hashOpKey(requestOp.opKey.trim()).slice(0, 16),
    }, 'op.accepted');
    reply.code(202);
    return toComputeOperation(op);
  });

  app.post('/v1/tts-playback-plans/operations', {
    schema: {
      body: jsonSchema(ttsPlaybackPlanOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackPlanOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }

    const planSignature = computePlaybackPlanSignature({
      ...parsed.data,
      sessionId: `plan:${parsed.data.documentId}:${parsed.data.settingsHash}`,
    });
    const documentSource = parsed.data.planning.documentSource;
    const requestOp: WorkerOperationRequest = {
      kind: 'tts_playback_plan',
      opKey: buildTtsPlaybackPlanOperationKey({
        documentId: parsed.data.documentId,
        documentVersion: parsed.data.documentVersion,
        readerType: parsed.data.readerType,
        settingsHash: parsed.data.settingsHash,
        planSignature,
        startOrdinal: parsed.data.startOrdinal,
        startSegmentKey: parsed.data.planning.startSegmentKey,
        startText: parsed.data.planning.startText,
        startPage: documentSource?.startPage,
        startSpineIndex: documentSource?.startSpineIndex,
        startCharOffset: documentSource?.startCharOffset,
      }),
      payload: parsed.data,
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
    app.log.info({
      kind: requestOp.kind,
      opId: op.opId,
      jobId: op.jobId,
      status: op.status,
      opKeyHash: hashOpKey(requestOp.opKey.trim()).slice(0, 16),
    }, 'op.accepted');
    reply.code(202);
    return toComputeOperation(op);
  });

  app.post('/v1/pdf-layout/resolve', {
    schema: {
      body: jsonSchema(pdfResolveSchema),
      response: { 200: jsonSchema(pdfLayoutResolutionSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = pdfResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    await ensureOrphanedOpRecovery();
    const artifactKey = parsedPdfArtifactKey({
      documentId: parsed.data.documentId,
      namespace: parsed.data.namespace,
      prefix: s3Prefix,
    });
    const hasArtifact = await deps.artifactExists?.(artifactKey) ?? false;
    const opKey = buildPdfOperationKey(parsed.data);
    const index = await deps.operationStateStore.getOpIndex?.(opKey);
    const operation = index?.opId ? await deps.operationStateStore.getOpState(index.opId) : null;
    return {
      artifact: hasArtifact ? { objectKey: artifactKey } : null,
      operation: operation ? toComputeOperation(operation) : null,
    };
  });

  app.get('/v1/operations/:opId', {
    schema: {
      params: jsonSchema(operationParamsSchema),
      response: { 200: jsonSchema(computeOperationSchema), 400: errorResponseSchema, 404: errorResponseSchema },
    },
  }, async (request, reply) => {
    const params = operationParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Invalid op id' };
    }

    const state = await getOpState(params.data.opId);
    if (!state) {
      reply.code(404);
      return { error: 'Operation not found' };
    }
    return toComputeOperation(state);
  });

  app.get('/v1/operations/:opId/events', {
    schema: {
      params: jsonSchema(operationParamsSchema),
      querystring: jsonSchema(operationEventsQuerySchema),
      response: {
        200: { type: 'string', description: 'Server-sent ComputeOperationEvent stream' },
        400: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const params = operationParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Invalid op id' };
    }

    const initial = await getOpState(params.data.opId);
    if (!initial) {
      reply.code(404);
      return { error: 'Operation not found' };
    }

    const cursorQueryRaw = request.query as { sinceEventId?: string | number | null } | undefined;
    const cursorFromQuery = Number(cursorQueryRaw?.sinceEventId ?? 0);
    const lastEventIdHeader = request.headers['last-event-id'];
    const cursorFromHeader = Number(
      Array.isArray(lastEventIdHeader) ? (lastEventIdHeader[0] ?? 0) : (lastEventIdHeader ?? 0),
    );
    const sinceEventId = Math.max(
      0,
      Number.isFinite(cursorFromQuery) ? Math.floor(cursorFromQuery) : 0,
      Number.isFinite(cursorFromHeader) ? Math.floor(cursorFromHeader) : 0,
    );

    reply.hijack();
    releaseHttp(request);
    onActiveSseChanged(1);
    markActivity('sse_started');
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.write(encodeSseFrame({ retry: OP_EVENTS_RECONNECT_HINT_MS }));

    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let keepalive: NodeJS.Timeout | null = null;

    const writeSnapshot = (snapshot: StreamedOperationState, eventId: number): void => {
      if (closed || reply.raw.writableEnded) return;
      const frameEvent: ComputeOperationEvent<PdfLayoutJobResult | TtsPlaybackJobResult | TtsPlaybackPlanJobResult> = {
        eventId,
        snapshot: toComputeOperation(snapshot),
      };
      reply.raw.write(encodeSseFrame({ id: eventId, event: 'snapshot', data: frameEvent }));
    };

    const closeStream = (): void => {
      if (closed) return;
      closed = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
      onActiveSseChanged(-1);
      markActivity('sse_closed');
      if (!reply.raw.writableEnded) reply.raw.end();
    };

    request.raw.on('close', closeStream);

    try {
      let current = initial;
      let signature = JSON.stringify(current);
      writeSnapshot(current, sinceEventId > 0 ? sinceEventId : 0);
      if (isTerminalStatus(current.status)) return reply;

      keepalive = setInterval(() => {
        if (!closed && !reply.raw.writableEnded) reply.raw.write(': keepalive\n\n');
      }, OP_EVENTS_KEEPALIVE_MS);

      unsubscribe = await deps.operationEventStream.subscribe({
        opId: params.data.opId,
        sinceEventId,
        onEvent: (event) => {
          if (closed || event.snapshot.opId !== params.data.opId) return;
          const nextSignature = JSON.stringify(event.snapshot);
          if (nextSignature !== signature) {
            current = event.snapshot;
            signature = nextSignature;
            markActivity('sse_event');
            writeSnapshot(current, event.eventId);
          }
          if (isTerminalStatus(event.snapshot.status)) closeStream();
        },
        onError: (error) => {
          app.log.warn({ opId: params.data.opId, error: toErrorMessage(error) }, 'op events stream loop error');
          closeStream();
        },
      });

      await new Promise<void>((resolve) => request.raw.once('close', resolve));
    } catch (error) {
      app.log.warn({ opId: params.data.opId, error: toErrorMessage(error) }, 'op events stream loop error');
    } finally {
      closeStream();
    }
    return reply;
  });
}

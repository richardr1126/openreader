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
} from '../operations/contracts';
import { hashOpKey } from '../infrastructure/nats-adapters';
import type { StreamedOperationState } from '../operations/recovery';
import type { ReconciliationStateStore } from '../operations/reconciliation';
import { parsedPdfArtifactKey } from '../storage/artifact-addressing';
import { buildPdfOperationKey, buildTtsPlaybackOperationKey } from '../operations/keys';
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
  ttsPlaybackOperationCreateSchema,
} from './schemas';

const OP_EVENTS_KEEPALIVE_MS = 15_000;
const OP_EVENTS_RECONNECT_HINT_MS = 120_000;
const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

interface OperationEventStreamLike {
  subscribe(input: {
    opId: string;
    sinceEventId?: number;
    onEvent: (event: WorkerOperationEvent<PdfLayoutJobResult | TtsPlaybackJobResult>) => void | Promise<void>;
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
    startOrdinal: number;
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
        startOrdinal: ttsPlaybackSessions.startOrdinal,
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
        400: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
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
    const streamAudio = async function* (): AsyncGenerator<Buffer> {
      // Resolved lazily once the worker has set planObjectKey, which it writes
      // together with the absolute startOrdinal. Reading initialSession.startOrdinal
      // eagerly could capture a stale 0 before the worker resolves the start
      // position against the position-independent plan.
      let ordinal: number | null = null;
      let wroteFirstByte = false;
      for (;;) {
        if (closed) return;
        const session = await readPlaybackSession(sessionId);
        if (!session) return;
        if (Date.now() > session.expiresAt) {
          app.log.info({ sessionId, ordinal }, 'tts.playback.audio.session_expired');
          return;
        }
        if (session.status !== 'queued' && session.status !== 'running' && session.status !== 'succeeded') {
          app.log.info({ sessionId, ordinal, status: session.status }, 'tts.playback.audio.session_stopped');
          return;
        }

        if (ordinal === null) {
          if (!session.planObjectKey) {
            // Worker has not resolved this session's start ordinal yet.
            await sleep(250);
            continue;
          }
          ordinal = Math.max(0, Math.floor(session.startOrdinal));
        }

        const segment = await readCompletedPlaybackSegment(session, ordinal);
        if (!segment) {
          if (session.status === 'succeeded') {
            app.log.info({ sessionId, ordinal }, 'tts.playback.audio.stopped_at_gap');
            return;
          }
          await sleep(500);
          continue;
        }

        const waitMs = Date.now() - startedAt;
        await updatePlaybackCursor(sessionId, ordinal).catch((error) => {
          app.log.warn({ sessionId, ordinal, error: toErrorMessage(error) }, 'tts.playback.cursor_update_failed');
        });
        const bytes = Buffer.from(await storage.readObject(segment.audioKey));
        const body = wroteFirstByte ? stripId3Tag(bytes) : bytes;
        if (!wroteFirstByte) {
          wroteFirstByte = true;
          app.log.info({ sessionId, ordinal, firstByteMs: waitMs }, 'tts.playback.audio.first_byte');
        } else {
          app.log.info({ sessionId, ordinal, waitMs }, 'tts.playback.audio.segment');
        }
        markActivity('tts_playback_audio_segment');
        yield body;
        ordinal += 1;
      }
    };

    reply.header('Content-Type', 'audio/mpeg');
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Accel-Buffering', 'no');
    return Readable.from(streamAudio());
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
      const frameEvent: ComputeOperationEvent<PdfLayoutJobResult | TtsPlaybackJobResult> = {
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

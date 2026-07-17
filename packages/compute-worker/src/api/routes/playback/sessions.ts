import { buildTtsPlaybackCanonicalSessionId } from '@openreader/tts/playback-scope';
import { hashOpKey } from '../../../infrastructure/nats-adapters';
import type { WorkerOperationRequest } from '../../../operations/contracts';
import {
  buildTtsPlaybackOperationKey,
  buildTtsPlaybackPlanOperationKey,
} from '../../../operations/keys';
import { computePlaybackPlanSignature } from '../../../jobs/playback/plan';
import { toComputeOperation } from '../../compute-operation';
import type { PlaybackSessionController } from '../../playback/session-controller';
import type { PlaybackSessionReadModel } from '../../playback/session-read-model';
import type { ComputeWorkerRouteContext } from '../../route-context';
import { toErrorMessage } from '../../route-context';
import {
  apiErrorResponseSchema,
  computeOperationSchema,
  jsonSchema,
  ttsPlaybackCursorUpdateSchema,
  ttsPlaybackOperationCreateSchema,
  ttsPlaybackPlanOperationCreateSchema,
  ttsPlaybackSessionResolutionSchema,
  ttsPlaybackSessionResolveSchema,
} from '../../schemas';

const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

export function registerPlaybackSessionRoutes(
  context: ComputeWorkerRouteContext,
  readModel: PlaybackSessionReadModel,
  controller: PlaybackSessionController,
): void {
  const { app, playbackStorage, getOpState } = context;

  app.post('/v1/tts-playback/sessions/resolve', {
    schema: {
      body: jsonSchema(ttsPlaybackSessionResolveSchema),
      response: {
        200: jsonSchema(ttsPlaybackSessionResolutionSchema),
        400: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackSessionResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    if (!playbackStorage) {
      reply.code(503);
      return { error: 'TTS playback storage is unavailable' };
    }
    const sessionId = buildTtsPlaybackCanonicalSessionId(parsed.data);
    const session = await readModel.readSession(sessionId);
    const operation = session?.workerOpId
      ? await getOpState(session.workerOpId).catch((error) => {
        app.log.warn(
          { sessionId, opId: session.workerOpId, error: toErrorMessage(error) },
          'tts.playback.resolve_state_read_failed',
        );
        return null;
      })
      : null;
    const progress = operation?.kind === 'tts_playback' && operation.progress && 'completedCount' in operation.progress
      ? operation.progress
      : null;
    return {
      sessionId,
      session,
      operation: operation ? toComputeOperation(operation) : null,
      progress,
    };
  });

  app.get('/v1/tts-playback/sessions/:sessionId', {
    schema: {
      params: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
      response: { 400: errorResponseSchema, 404: errorResponseSchema },
    },
  }, async (request, reply) => {
    const sessionId = (request.params as { sessionId?: string }).sessionId?.trim() ?? '';
    if (!sessionId) {
      reply.code(400);
      return { error: 'Missing playback session id' };
    }
    const session = await readModel.readSession(sessionId);
    if (!session) {
      reply.code(404);
      return { error: 'Playback session not found' };
    }
    return session;
  });

  app.get('/v1/tts-playback/sessions/:sessionId/segments', {
    schema: {
      params: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
      querystring: {
        type: 'object',
        properties: { minOrdinal: { type: 'number' }, limit: { type: 'number' } },
      },
      response: { 400: errorResponseSchema, 404: errorResponseSchema },
    },
  }, async (request, reply) => {
    const sessionId = (request.params as { sessionId?: string }).sessionId?.trim() ?? '';
    const query = request.query as { minOrdinal?: string | number; limit?: string | number };
    if (!sessionId) {
      reply.code(400);
      return { error: 'Missing playback session id' };
    }
    const session = await readModel.readSession(sessionId);
    if (!session) {
      reply.code(404);
      return { error: 'Playback session not found' };
    }
    const minOrdinal = Math.max(0, Math.floor(Number(query.minOrdinal ?? 0)));
    const limit = Math.max(1, Math.min(Math.floor(Number(query.limit ?? 500)), 10000));
    const rows = await readModel.readSegmentIndexRows(session);
    return {
      sessionId,
      segments: rows.filter((row) => row.ordinal >= minOrdinal).slice(0, limit),
    };
  });

  app.put('/v1/tts-playback/sessions/:sessionId/cursor', {
    schema: {
      params: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
      body: jsonSchema(ttsPlaybackCursorUpdateSchema),
      response: { 400: errorResponseSchema, 404: errorResponseSchema },
    },
  }, async (request, reply) => {
    const sessionId = (request.params as { sessionId?: string }).sessionId?.trim() ?? '';
    if (!sessionId) {
      reply.code(400);
      return { error: 'Missing playback session id' };
    }
    const parsed = ttsPlaybackCursorUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    const session = await readModel.readSession(sessionId);
    if (!session) {
      reply.code(404);
      return { error: 'Playback session not found' };
    }
    const now = Date.now();
    await playbackStorage?.sessions.patchSession(sessionId, {
      cursorOrdinal: parsed.data.ordinal,
      cursorUpdatedAt: now,
      ...(parsed.data.expiresAt === undefined ? {} : { expiresAt: parsed.data.expiresAt }),
      updatedAt: now,
    });
    await controller.enqueueContinuationIfNeeded({
      ...session,
      cursorOrdinal: parsed.data.ordinal,
      cursorUpdatedAt: now,
      expiresAt: parsed.data.expiresAt ?? session.expiresAt,
      updatedAt: now,
    }, now, 'cursor');
    return {
      sessionId,
      cursorOrdinal: parsed.data.ordinal,
      expiresAt: parsed.data.expiresAt ?? session.expiresAt,
    };
  });
}

export function registerPlaybackJobRoutes(
  context: ComputeWorkerRouteContext,
  controller: PlaybackSessionController,
): void {
  const { app, deps, playbackStorage, ensureOrphanedOpRecovery } = context;
  app.post('/v1/tts-playback/sessions/jobs', {
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
    if (parsed.data.planning.selectedOrdinal === undefined) {
      reply.code(400);
      return { error: 'TTS playback operation requires a worker-plan ordinal' };
    }
    await controller.putSessionState(parsed.data, 'queued', null);
    const requestOp: WorkerOperationRequest = {
      kind: 'tts_playback',
      opKey: buildTtsPlaybackOperationKey(parsed.data),
      payload: parsed.data,
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
    await playbackStorage?.sessions.patchSession(parsed.data.sessionId, {
      workerOpId: op.opId,
      status: op.status === 'failed' ? 'failed' : op.status === 'succeeded' ? 'succeeded' : 'running',
      lastError: op.status === 'failed' ? op.error?.message ?? 'Failed to enqueue playback operation' : null,
      updatedAt: Date.now(),
    }).catch((error) => {
      app.log.warn(
        { sessionId: parsed.data.sessionId, opId: op.opId, error: toErrorMessage(error) },
        'tts.playback.session_worker_op_patch_failed',
      );
    });
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

  app.post('/v1/tts-playback/plans/jobs', {
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
    const requestOp: WorkerOperationRequest = {
      kind: 'tts_playback_plan',
      opKey: buildTtsPlaybackPlanOperationKey({
        documentId: parsed.data.documentId,
        documentVersion: parsed.data.documentVersion,
        readerType: parsed.data.readerType,
        settingsHash: parsed.data.settingsHash,
        planSignature,
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
}

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { encodeSseFrame } from '../operations';
import type {
  PdfLayoutJobResult,
  WorkerJobTiming,
  WorkerOperationEvent,
  WorkerOperationRequest,
  WorkerOperationState,
  WhisperAlignJobResult,
} from '../operations/contracts';
import { hashOpKey } from '../infrastructure/nats-adapters';
import type { StreamedOperationState } from '../operations/recovery';
import type { ReconciliationStateStore } from '../operations/reconciliation';
import { parsedPdfArtifactKey } from '../storage/artifact-addressing';
import { buildPdfOperationKey, buildWhisperOperationKey } from '../operations/keys';
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
  whisperOperationCreateSchema,
} from './schemas';

const OP_EVENTS_KEEPALIVE_MS = 15_000;
const OP_EVENTS_RECONNECT_HINT_MS = 120_000;
const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

interface OperationEventStreamLike {
  subscribe(input: {
    opId: string;
    sinceEventId?: number;
    onEvent: (event: WorkerOperationEvent<WhisperAlignJobResult | PdfLayoutJobResult>) => void | Promise<void>;
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
    s3Prefix,
    ensureOrphanedOpRecovery,
    getOpState,
    getNatsConnected,
    releaseHttp,
    markActivity,
    onActiveSseChanged,
  } = input;

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

  app.post('/v1/whisper-align/operations', {
    schema: {
      body: jsonSchema(whisperOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = whisperOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }

    const requestOp: WorkerOperationRequest = {
      kind: 'whisper_align',
      opKey: buildWhisperOperationKey(parsed.data),
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
      const frameEvent: ComputeOperationEvent<WhisperAlignJobResult | PdfLayoutJobResult> = {
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

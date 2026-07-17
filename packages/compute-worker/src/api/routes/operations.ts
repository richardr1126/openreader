import { encodeSseFrame } from '../../operations';
import type {
  AccountExportJobResult,
  DocumentConversionJobResult,
  DocumentPreviewJobResult,
  PdfLayoutJobResult,
  TtsPlaybackExportArtifactResult,
  TtsPlaybackJobResult,
  TtsPlaybackPlanJobResult,
} from '../../operations/contracts';
import type { StreamedOperationState } from '../../operations/recovery';
import { toComputeOperation, type ComputeOperationEvent } from '../compute-operation';
import type { ComputeWorkerRouteContext } from '../route-context';
import { isTerminalStatus, toErrorMessage } from '../route-context';
import {
  apiErrorResponseSchema,
  computeOperationSchema,
  jsonSchema,
  operationEventsQuerySchema,
  operationParamsSchema,
} from '../schemas';

const OP_EVENTS_KEEPALIVE_MS = 15_000;
const OP_EVENTS_RECONNECT_HINT_MS = 120_000;
const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

type OperationRouteResult =
  | PdfLayoutJobResult
  | TtsPlaybackJobResult
  | TtsPlaybackPlanJobResult
  | TtsPlaybackExportArtifactResult
  | DocumentPreviewJobResult
  | DocumentConversionJobResult
  | AccountExportJobResult;

export function registerOperationRoutes(context: ComputeWorkerRouteContext): void {
  const {
    app,
    deps,
    getOpState,
    releaseHttp,
    markActivity,
    onActiveSseChanged,
  } = context;

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
      const frameEvent: ComputeOperationEvent<OperationRouteResult> = {
        eventId,
        snapshot: toComputeOperation(snapshot),
      };
      reply.raw.write(encodeSseFrame({ id: eventId, event: 'snapshot', data: frameEvent }));
    };
    const closeStream = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      if (keepalive) clearInterval(keepalive);
      keepalive = null;
      onActiveSseChanged(-1);
      markActivity('sse_closed');
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    request.raw.on('close', closeStream);

    try {
      let signature = JSON.stringify(initial);
      writeSnapshot(initial, sinceEventId > 0 ? sinceEventId : 0);
      if (isTerminalStatus(initial.status)) return reply;
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
            signature = nextSignature;
            markActivity('sse_event');
            writeSnapshot(event.snapshot, event.eventId);
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

import { hashOpKey } from '../../infrastructure/nats-adapters';
import {
  cancelKokoroDownload,
  isKokoroDownloading,
  kokoroAssetStatus,
  KokoroDownloadInProgressError,
} from '../../inference/kokoro/model-files';
import { removeKokoro } from '../../inference/kokoro/engine';
import type { WorkerOperationRequest } from '../../operations/contracts';
import { buildModelDownloadOperationKey } from '../../operations/keys';
import { toComputeOperation } from '../compute-operation';
import type { ComputeWorkerRouteContext } from '../route-context';
import {
  apiErrorResponseSchema,
  computeOperationSchema,
  jsonSchema,
  modelCancelResultSchema,
  modelParamsSchema,
  modelStatusSchema,
} from '../schemas';

const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

/**
 * Models this worker downloads on first use, managed ahead of time from the
 * Local voices card. Each worker replica keeps its own copy, so these describe
 * and change only the replica that answers.
 */
export function registerModelRoutes(context: ComputeWorkerRouteContext): void {
  const { app, deps, ensureOrphanedOpRecovery } = context;

  app.get('/v1/models/:model', {
    schema: {
      params: jsonSchema(modelParamsSchema),
      response: { 200: jsonSchema(modelStatusSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Unknown model' };
    }
    const index = await deps.operationStateStore.getOpIndex?.(buildModelDownloadOperationKey(params.data.model));
    const operation = index?.opId ? await deps.operationStateStore.getOpState(index.opId) : null;
    return {
      model: params.data.model,
      components: await kokoroAssetStatus(),
      downloading: isKokoroDownloading(),
      operation: operation ? toComputeOperation(operation) : null,
    };
  });

  app.post('/v1/models/:model/download', {
    schema: {
      params: jsonSchema(modelParamsSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Unknown model' };
    }
    const operation: WorkerOperationRequest = {
      kind: 'model_download',
      opKey: buildModelDownloadOperationKey(params.data.model),
      payload: { model: params.data.model },
    };
    await ensureOrphanedOpRecovery();
    const state = await deps.orchestrator.enqueueOrReuse(operation);
    app.log.info({
      kind: operation.kind,
      opId: state.opId,
      jobId: state.jobId,
      status: state.status,
      opKeyHash: hashOpKey(operation.opKey).slice(0, 16),
    }, 'op.accepted');
    reply.code(202);
    return toComputeOperation(state);
  });

  app.post('/v1/models/:model/cancel', {
    schema: {
      params: jsonSchema(modelParamsSchema),
      response: { 200: jsonSchema(modelCancelResultSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Unknown model' };
    }
    return { cancelled: cancelKokoroDownload() };
  });

  app.delete('/v1/models/:model', {
    schema: {
      params: jsonSchema(modelParamsSchema),
      response: { 204: { type: 'null' }, 400: errorResponseSchema, 409: errorResponseSchema },
    },
  }, async (request, reply) => {
    const params = modelParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Unknown model' };
    }
    try {
      await removeKokoro();
    } catch (error) {
      if (!(error instanceof KokoroDownloadInProgressError)) throw error;
      reply.code(409);
      return { error: error.message };
    }
    reply.code(204);
    return null;
  });
}

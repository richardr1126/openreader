import { hashOpKey } from '../../infrastructure/nats-adapters';
import type { WorkerOperationRequest } from '../../operations/contracts';
import { buildEmailDeliveryOperationKey } from '../../operations/keys';
import { toComputeOperation } from '../compute-operation';
import type { ComputeWorkerRouteContext } from '../route-context';
import {
  apiErrorResponseSchema,
  computeOperationSchema,
  emailDeliveryOperationCreateSchema,
  jsonSchema,
} from '../schemas';

export function registerEmailDeliveryRoutes(context: ComputeWorkerRouteContext): void {
  const { app, deps, ensureOrphanedOpRecovery } = context;
  app.post('/v1/email-deliveries/jobs', {
    schema: {
      body: jsonSchema(emailDeliveryOperationCreateSchema),
      response: {
        202: jsonSchema(computeOperationSchema),
        400: jsonSchema(apiErrorResponseSchema),
      },
    },
  }, async (request, reply) => {
    const parsed = emailDeliveryOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    const operation: WorkerOperationRequest = {
      kind: 'email_delivery',
      opKey: buildEmailDeliveryOperationKey(parsed.data.deliveryId),
      payload: parsed.data,
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
}

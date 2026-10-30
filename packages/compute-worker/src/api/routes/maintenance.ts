import { buildMaintenanceOperationKey } from '../../operations/keys';
import { toComputeOperation } from '../compute-operation';
import type { ComputeWorkerRouteContext } from '../route-context';
import { apiErrorResponseSchema, computeOperationSchema, jsonSchema, maintenanceOperationCreateSchema } from '../schemas';

export function registerMaintenanceRoutes({ app, deps }: ComputeWorkerRouteContext): void {
  app.post('/v1/maintenance/jobs', {
    schema: {
      body: jsonSchema(maintenanceOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: jsonSchema(apiErrorResponseSchema) },
    },
  }, async (request, reply) => {
    const parsed = maintenanceOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid maintenance request' });
    const operation = await deps.orchestrator.enqueueOrReuse({
      kind: 'maintenance', opKey: buildMaintenanceOperationKey(parsed.data), payload: parsed.data,
    });
    return reply.code(202).send(toComputeOperation(operation));
  });
}

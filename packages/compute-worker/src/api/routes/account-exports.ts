import type { FastifyReply, FastifyRequest } from 'fastify';
import { hashOpKey } from '../../infrastructure/nats-adapters';
import type { AccountExportArtifactMetadata, WorkerOperationRequest } from '../../operations/contracts';
import { buildAccountExportOperationKey } from '../../operations/keys';
import { accountExportMetadataArtifactKey } from '../../storage/artifact-addressing';
import { expireExportArtifactsUnderRoot } from '../../storage/export-retention';
import { toComputeOperation } from '../compute-operation';
import type { ComputeWorkerRouteContext } from '../route-context';
import {
  accountExportOperationCreateSchema,
  accountExportResolutionSchema,
  accountExportResolveSchema,
  apiErrorResponseSchema,
  computeOperationSchema,
  exportRetentionSchema,
  jsonSchema,
} from '../schemas';

const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

async function readAccountExportMetadata(
  context: ComputeWorkerRouteContext,
  input: typeof accountExportResolveSchema._output,
): Promise<AccountExportArtifactMetadata | null> {
  const key = accountExportMetadataArtifactKey({
    artifactId: input.artifactId,
    storageUserId: input.storageUserId,
    namespace: input.namespace,
    prefix: context.s3Prefix,
  });
  try {
    const parsed = JSON.parse(Buffer.from(await context.storage.readObject(key)).toString('utf8')) as AccountExportArtifactMetadata;
    if (
      parsed.schemaVersion !== 1
      || parsed.artifactId !== input.artifactId
      || parsed.status !== 'ready'
      || parsed.storageUserId !== input.storageUserId
      || parsed.namespace !== input.namespace
      || parsed.exportSchemaVersion !== input.schemaVersion
      || parsed.manifestHash !== input.manifestHash
    ) return null;
    return await context.storage.objectExists(parsed.objectKey).catch(() => false) ? parsed : null;
  } catch {
    return null;
  }
}

export function registerAccountExportRoutes(context: ComputeWorkerRouteContext): void {
  const { app, deps, ensureOrphanedOpRecovery } = context;

  app.post('/v1/account-exports/jobs', {
    schema: {
      body: jsonSchema(accountExportOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = accountExportOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    const requestOp: WorkerOperationRequest = {
      kind: 'account_export',
      opKey: buildAccountExportOperationKey(parsed.data),
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

  app.post('/v1/account-exports/resolve', {
    schema: {
      body: jsonSchema(accountExportResolveSchema),
      response: { 200: jsonSchema(accountExportResolutionSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = accountExportResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    await ensureOrphanedOpRecovery();
    const artifact = await readAccountExportMetadata(context, parsed.data);
    const index = await deps.operationStateStore.getOpIndex?.(buildAccountExportOperationKey(parsed.data));
    const operation = index?.opId ? await deps.operationStateStore.getOpState(index.opId) : null;
    return { artifact, operation: operation ? toComputeOperation(operation) : null };
  });
}

export function registerAccountExportRetentionRoute(context: ComputeWorkerRouteContext): void {
  const { app } = context;
  const retentionRouteSchema = {
    body: jsonSchema(exportRetentionSchema),
    response: {
      200: {
        type: 'object',
        properties: { expiredArtifacts: { type: 'number' }, deletedObjects: { type: 'number' } },
        required: ['expiredArtifacts', 'deletedObjects'],
      },
      400: errorResponseSchema,
    },
  };
  const retentionHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = exportRetentionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    return expireExportArtifactsUnderRoot({
      storage: context.storage,
      exportRoot: `${context.s3Prefix}/account_exports_v1/`,
      maxAgeMs: parsed.data.maxAgeMs,
    });
  };
  app.post('/v1/account-exports/expire', { schema: retentionRouteSchema }, retentionHandler);
}

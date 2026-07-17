import type { FastifyReply, FastifyRequest } from 'fastify';
import { hashOpKey } from '../../../infrastructure/nats-adapters';
import type { TtsPlaybackExportArtifactMetadata, WorkerOperationRequest } from '../../../operations/contracts';
import { buildTtsPlaybackExportOperationKey } from '../../../operations/keys';
import { ttsPlaybackExportMetadataArtifactKey } from '../../../storage/artifact-addressing';
import { expireExportArtifactsUnderRoot } from '../../../storage/export-retention';
import { toComputeOperation } from '../../compute-operation';
import type { ComputeWorkerRouteContext } from '../../route-context';
import {
  apiErrorResponseSchema,
  computeOperationSchema,
  exportRetentionSchema,
  jsonSchema,
  ttsPlaybackExportArtifactCreateSchema,
  ttsPlaybackExportArtifactMetadataSchema,
  ttsPlaybackExportArtifactResolutionSchema,
  ttsPlaybackExportArtifactResolveSchema,
} from '../../schemas';

const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

async function readExportMetadata(context: ComputeWorkerRouteContext, input: {
  artifactId: string;
  storageUserId: string;
  documentId: string;
}): Promise<TtsPlaybackExportArtifactMetadata | null> {
  const key = ttsPlaybackExportMetadataArtifactKey({ ...input, prefix: context.s3Prefix });
  try {
    const parsed = JSON.parse(Buffer.from(await context.storage.readObject(key)).toString('utf8')) as TtsPlaybackExportArtifactMetadata;
    if (parsed.schemaVersion !== 1 || parsed.artifactId !== input.artifactId || parsed.status !== 'ready') return null;
    return await context.storage.objectExists(parsed.objectKey).catch(() => false) ? parsed : null;
  } catch {
    return null;
  }
}

export function registerPlaybackExportRoutes(context: ComputeWorkerRouteContext): void {
  const { app } = context;

  app.get('/v1/tts-playback/exports/:artifactId', {
    schema: {
      params: {
        type: 'object',
        properties: { artifactId: { type: 'string' } },
        required: ['artifactId'],
      },
      querystring: {
        type: 'object',
        properties: { storageUserId: { type: 'string' }, documentId: { type: 'string' } },
        required: ['storageUserId', 'documentId'],
      },
      response: {
        200: jsonSchema(ttsPlaybackExportArtifactMetadataSchema),
        400: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const artifactId = (request.params as { artifactId?: string }).artifactId?.trim() ?? '';
    const query = request.query as { storageUserId?: string; documentId?: string };
    const storageUserId = query.storageUserId?.trim() ?? '';
    const documentId = query.documentId?.trim() ?? '';
    if (!artifactId || !storageUserId || !documentId) {
      reply.code(400);
      return { error: 'Missing export artifact scope' };
    }
    const artifact = await readExportMetadata(context, { artifactId, storageUserId, documentId });
    if (!artifact) {
      reply.code(404);
      return { error: 'Export artifact not found' };
    }
    return artifact;
  });
}

export function registerPlaybackExportJobRoutes(context: ComputeWorkerRouteContext): void {
  const { app, deps, ensureOrphanedOpRecovery } = context;
  app.post('/v1/tts-playback/exports/jobs', {
    schema: {
      body: jsonSchema(ttsPlaybackExportArtifactCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackExportArtifactCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    const requestOp: WorkerOperationRequest = {
      kind: 'tts_playback_export',
      opKey: buildTtsPlaybackExportOperationKey(parsed.data),
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

  app.post('/v1/tts-playback/exports/resolve', {
    schema: {
      body: jsonSchema(ttsPlaybackExportArtifactResolveSchema),
      response: { 200: jsonSchema(ttsPlaybackExportArtifactResolutionSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackExportArtifactResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    await ensureOrphanedOpRecovery();
    const artifact = await readExportMetadata(context, parsed.data);
    const index = await deps.operationStateStore.getOpIndex?.(buildTtsPlaybackExportOperationKey(parsed.data));
    const operation = index?.opId ? await deps.operationStateStore.getOpState(index.opId) : null;
    return { artifact, operation: operation ? toComputeOperation(operation) : null };
  });
}

export function registerPlaybackExportRetentionRoute(context: ComputeWorkerRouteContext): void {
  const { app, storage, s3Prefix } = context;
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
      storage,
      exportRoot: `${s3Prefix}/tts_playback_exports_v1/`,
      maxAgeMs: parsed.data.maxAgeMs,
    });
  };
  app.post('/v1/tts-playback/exports/expire', { schema: retentionRouteSchema }, retentionHandler);
}

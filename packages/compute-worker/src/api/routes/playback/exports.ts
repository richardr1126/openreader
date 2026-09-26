import type { FastifyReply, FastifyRequest } from 'fastify';
import { hashOpKey } from '../../../infrastructure/nats-adapters';
import type { TtsPlaybackExportArtifactMetadata, WorkerOperationRequest } from '../../../operations/contracts';
import { buildTtsPlaybackExportOperationKey } from '../../../operations/keys';
import { ttsPlaybackExportMetadataArtifactKey } from '../../../storage/artifact-addressing';
import { expireExportArtifactsUnderRoot } from '../../../storage/export-retention';
import { groupExportChapters, type ExportChapterGroup } from '../../../jobs/playback/export-chapters';
import { readPersistedTtsPlaybackPlanSegments } from '../../../jobs/playback/plan';
import { toComputeOperation } from '../../compute-operation';
import type { PlaybackSessionReadModel } from '../../playback/session-read-model';
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
  ttsPlaybackExportProgressSummarySchema,
  ttsPlaybackSessionCancelResponseSchema,
  ttsPlaybackSessionCancelSchema,
} from '../../schemas';

const errorResponseSchema = jsonSchema(apiErrorResponseSchema);
const CHAPTER_GROUP_CACHE_MAX = 4;
const sessionIdParamsSchema = {
  type: 'object',
  properties: { sessionId: { type: 'string' } },
  required: ['sessionId'],
} as const;

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

/**
 * Export-session progress and control. Chapter grouping is derived from the
 * immutable plan artifact, so it is cached per plan key; segment states come
 * from the shared sidecar read model.
 */
export function registerPlaybackExportSessionRoutes(
  context: ComputeWorkerRouteContext,
  readModel: PlaybackSessionReadModel,
): void {
  const { app, storage, playbackStorage } = context;
  const chapterGroups = new Map<string, ExportChapterGroup[]>();

  const readChapterGroups = async (planObjectKey: string): Promise<ExportChapterGroup[] | null> => {
    const cached = chapterGroups.get(planObjectKey);
    if (cached) return cached;
    const segments = await readPersistedTtsPlaybackPlanSegments(storage, planObjectKey);
    if (!segments) return null;
    const groups = groupExportChapters(segments);
    if (chapterGroups.size >= CHAPTER_GROUP_CACHE_MAX) {
      const oldest = chapterGroups.keys().next().value;
      if (oldest !== undefined) chapterGroups.delete(oldest);
    }
    chapterGroups.set(planObjectKey, groups);
    return groups;
  };

  app.get('/v1/tts-playback/sessions/:sessionId/export-progress', {
    schema: {
      params: sessionIdParamsSchema,
      response: {
        200: jsonSchema(ttsPlaybackExportProgressSummarySchema),
        400: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const sessionId = (request.params as { sessionId?: string }).sessionId?.trim() ?? '';
    if (!sessionId) {
      reply.code(400);
      return { error: 'Missing playback session id' };
    }
    const session = await readModel.readSession(sessionId);
    const groups = session?.planObjectKey ? await readChapterGroups(session.planObjectKey) : null;
    if (!session || !groups) {
      reply.code(404);
      return { error: 'Export session not found' };
    }
    const plannedSegments = groups.reduce((sum, group) => sum + group.ordinals.length, 0);
    const states = await readModel.listSegmentStates(session, plannedSegments);
    let completedSegments = 0;
    let skippedSegments = 0;
    let lastSkipError: { message: string | null; code: string | null } | null = null;
    const chapters = groups.map((group) => {
      let completed = 0;
      let skipped = 0;
      let generating = 0;
      let durationMs = 0;
      for (const ordinal of group.ordinals) {
        const state = states.get(ordinal);
        if (state?.status === 'completed') {
          completed += 1;
          durationMs += state.durationMs;
        } else if (state?.status === 'error') {
          skipped += 1;
          lastSkipError = { message: state.message, code: state.code };
        } else if (state?.status === 'generating') {
          generating += 1;
        }
      }
      completedSegments += completed;
      skippedSegments += skipped;
      return {
        index: group.index,
        title: group.title,
        spineHref: group.spineHref,
        page: group.page,
        plannedSegments: group.ordinals.length,
        completedSegments: completed,
        skippedSegments: skipped,
        generatingSegments: generating,
        durationMs,
      };
    });
    return {
      sessionId,
      status: session.status,
      stopReason: session.stopReason ?? null,
      lastError: session.lastError,
      plannedSegments,
      completedSegments,
      skippedSegments,
      lastSkipError,
      chapters,
    };
  });

  app.post('/v1/tts-playback/sessions/:sessionId/cancel', {
    schema: {
      params: sessionIdParamsSchema,
      body: jsonSchema(ttsPlaybackSessionCancelSchema),
      response: {
        200: jsonSchema(ttsPlaybackSessionCancelResponseSchema),
        400: errorResponseSchema,
        404: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const sessionId = (request.params as { sessionId?: string }).sessionId?.trim() ?? '';
    const body = ttsPlaybackSessionCancelSchema.safeParse(request.body);
    if (!sessionId || !body.success) {
      reply.code(400);
      return { error: 'Missing playback session id or observed generation run' };
    }
    if (!playbackStorage) {
      reply.code(503);
      return { error: 'TTS playback storage is unavailable' };
    }
    const session = await playbackStorage.sessions.getSession(sessionId);
    if (!session) {
      reply.code(404);
      return { error: 'Playback session not found' };
    }
    // The document run checks status before every segment, so a canceled
    // session stops after its in-flight segments. Cached audio is kept and a
    // later start resumes from it. The write is conditional on the run the
    // caller observed, so a stop that races a resume never cancels the
    // replacement run.
    const canceled = (session.status === 'queued' || session.status === 'running')
      && await playbackStorage.sessions.patchSessionIfGenerationRun(sessionId, body.data.generationRunId, {
        status: 'canceled',
        lastError: null,
        updatedAt: Date.now(),
      }, session.sessionInstanceId);
    const current = canceled ? null : await playbackStorage.sessions.getSession(sessionId);
    return { sessionId, canceled, status: canceled ? 'canceled' : current?.status ?? null };
  });
}

import { clearTtsPlaybackArtifacts } from '../../playback/cache-clear';
import type { TtsPlaybackResetScope, TtsPlaybackStorage } from '../../playback/storage';
import {
  clearDocumentPreviewArtifacts,
  clearPdfLayoutArtifacts,
  clearTtsPlaybackPlanArtifacts,
} from '../../storage/document-derived-cleanup';
import { ttsPlaybackPlanArtifactPrefix } from '../../storage/artifact-addressing';
import { cleanupUserStorageArtifacts } from '../../storage/user-storage-cleanup';
import { collectStorageUsage, reclaimableVariants } from '../../storage/storage-usage';
import { invalidatePlaybackOperationsForScope } from '../playback/operation-invalidation';
import type { PlaybackSessionReadModel } from '../playback/session-read-model';
import type { ComputeWorkerRouteContext } from '../route-context';
import {
  apiErrorResponseSchema,
  documentPreviewClearSchema,
  jsonSchema,
  pdfLayoutClearSchema,
  ttsPlaybackCacheClearSchema,
  ttsPlaybackCacheReclaimResponseSchema,
  ttsPlaybackCacheReclaimSchema,
  ttsPlaybackPlansClearSchema,
  userStorageCleanupSchema,
  userStorageUsageResponseSchema,
  userStorageUsageSchema,
} from '../schemas';

const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

export function registerCleanupRoutes(
  context: ComputeWorkerRouteContext,
  readModel: PlaybackSessionReadModel,
): void {
  const { app, deps, storage, playbackStorage, s3Prefix } = context;

  const resetPlaybackScope = async (
    playbackStorage: TtsPlaybackStorage,
    requestId: string,
    scope: TtsPlaybackResetScope,
    options: { namespace: string | null; readerType?: 'pdf' | 'epub' | 'html' },
  ) => {
    const now = Date.now();
    const timed = async <T>(phase: string, run: () => Promise<T>): Promise<T> => {
      const startedAt = Date.now();
      try {
        const result = await run();
        app.log.info({ requestId, phase, durationMs: Date.now() - startedAt },
          'tts.playback.cache_clear_phase');
        return result;
      } catch (error) {
        app.log.warn({ requestId, phase, durationMs: Date.now() - startedAt },
          'tts.playback.cache_clear_phase_failed');
        throw error;
      }
    };
    await playbackStorage.artifacts.incrementScopeEpoch(scope, now);
    const invalidatedPlaybackSessions = await timed('cancel_sessions', () => (
      playbackStorage.sessions.cancelSessionsForScope(scope, now)
    ));
    readModel.invalidateSidecarsForScope(scope);
    const invalidatedJobOperations = await timed('invalidate_operations', () => invalidatePlaybackOperationsForScope({
      scope,
      now,
      operationStateStore: deps.operationStateStore,
      orchestrator: deps.orchestrator,
      readSession: readModel.readSession,
    }));
    const deleted = await timed('delete_objects', () => clearTtsPlaybackArtifacts({
      storage,
      s3Prefix,
      scope: { ...scope, namespace: options.namespace, ...(options.readerType ? { readerType: options.readerType } : {}) },
    }));
    app.log.info({ requestId, durationMs: Date.now() - now, ...deleted,
      invalidatedPlaybackSessions, invalidatedJobOperations }, 'tts.playback.cache_clear_completed');
    return { ...deleted, invalidatedPlaybackSessions, invalidatedJobOperations };
  };

  app.post('/v1/tts-playback/cache/clear', {
    schema: {
      body: jsonSchema(ttsPlaybackCacheClearSchema),
      response: {
        200: {
          type: 'object',
          properties: {
            deletedAudioObjects: { type: 'number' },
            deletedSidecarObjects: { type: 'number' },
            deletedPlanObjects: { type: 'number' },
            deletedExportObjects: { type: 'number' },
            invalidatedPlaybackSessions: { type: 'number' },
            invalidatedJobOperations: { type: 'number' },
          },
          required: [
            'deletedAudioObjects',
            'deletedSidecarObjects',
            'deletedPlanObjects',
            'deletedExportObjects',
            'invalidatedPlaybackSessions',
            'invalidatedJobOperations',
          ],
        },
        400: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackCacheClearSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    const { namespace, readerType, ...scope } = parsed.data;
    if (scope.settingsHash !== undefined && scope.documentVersion === undefined) {
      reply.code(400);
      return { error: 'settingsHash requires documentVersion' };
    }
    if (!playbackStorage) {
      reply.code(503);
      return { error: 'TTS playback storage is unavailable' };
    }
    return resetPlaybackScope(playbackStorage, request.id, scope, { namespace, readerType });
  });

  app.post('/v1/tts-playback/cache/reclaim', {
    schema: {
      body: jsonSchema(ttsPlaybackCacheReclaimSchema),
      response: {
        200: jsonSchema(ttsPlaybackCacheReclaimResponseSchema),
        400: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackCacheReclaimSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    if (!playbackStorage) {
      reply.code(503);
      return { error: 'TTS playback storage is unavailable' };
    }
    const { storageUserId, documentId, keep } = parsed.data;
    const usage = await collectStorageUsage({
      storage,
      s3Prefix,
      storageUserId,
      documentId,
      attributeExports: true,
    });
    const variants = reclaimableVariants(usage.documents[0], keep);
    const totals = {
      reclaimedVariants: 0,
      deletedAudioObjects: 0,
      deletedSidecarObjects: 0,
      deletedExportObjects: 0,
      invalidatedPlaybackSessions: 0,
      invalidatedJobOperations: 0,
    };
    // Each unused variant goes through the same reset boundary as a full clear
    // (epoch bump, session cancel, operation invalidation, object deletion),
    // scoped to its version + settings hash so the kept variant and the shared
    // plan are untouched.
    for (const variant of variants) {
      const result = await resetPlaybackScope(playbackStorage, request.id, {
        storageUserId,
        documentId,
        documentVersion: variant.documentVersion,
        settingsHash: variant.settingsHash,
      }, { namespace: null });
      totals.reclaimedVariants += 1;
      totals.deletedAudioObjects += result.deletedAudioObjects;
      totals.deletedSidecarObjects += result.deletedSidecarObjects;
      totals.deletedExportObjects += result.deletedExportObjects;
      totals.invalidatedPlaybackSessions += result.invalidatedPlaybackSessions;
      totals.invalidatedJobOperations += result.invalidatedJobOperations;
    }
    return totals;
  });

  app.post('/v1/user-storage/usage', {
    schema: {
      body: jsonSchema(userStorageUsageSchema),
      response: {
        200: jsonSchema(userStorageUsageResponseSchema),
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = userStorageUsageSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    return collectStorageUsage({
      storage,
      s3Prefix,
      storageUserId: parsed.data.storageUserId,
      includePlayback: parsed.data.includePlayback,
      documentId: parsed.data.documentId,
      attributeExports: parsed.data.documentId !== undefined,
      derivedDocumentIds: parsed.data.derivedDocumentIds,
      namespace: parsed.data.namespace,
    });
  });

  app.post('/v1/pdf-layout/clear', {
    schema: {
      body: jsonSchema(pdfLayoutClearSchema),
      response: {
        200: {
          type: 'object',
          properties: { deletedParsedObjects: { type: 'number' } },
          required: ['deletedParsedObjects'],
        },
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = pdfLayoutClearSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    const deletedParsedObjects = await clearPdfLayoutArtifacts({ storage, s3Prefix, ...parsed.data });
    return { deletedParsedObjects };
  });

  app.post('/v1/document-previews/clear', {
    schema: {
      body: jsonSchema(documentPreviewClearSchema),
      response: {
        200: {
          type: 'object',
          properties: { deletedPreviewObjects: { type: 'number' } },
          required: ['deletedPreviewObjects'],
        },
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = documentPreviewClearSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    const deletedPreviewObjects = await clearDocumentPreviewArtifacts({ storage, s3Prefix, ...parsed.data });
    return { deletedPreviewObjects };
  });

  app.post('/v1/tts-playback/plans/clear', {
    schema: {
      body: jsonSchema(ttsPlaybackPlansClearSchema),
      response: {
        200: {
          type: 'object',
          properties: { deletedPlanObjects: { type: 'number' } },
          required: ['deletedPlanObjects'],
        },
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackPlansClearSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    readModel.invalidatePlansUnderPrefix(ttsPlaybackPlanArtifactPrefix({
      documentId: parsed.data.documentId,
      prefix: s3Prefix,
    }));
    const deletedPlanObjects = await clearTtsPlaybackPlanArtifacts({ storage, s3Prefix, ...parsed.data });
    return { deletedPlanObjects };
  });

  app.post('/v1/user-storage/cleanup', {
    schema: {
      body: jsonSchema(userStorageCleanupSchema),
      response: {
        200: {
          type: 'object',
          properties: {
            deletedObjects: { type: 'number' },
            deletedDocumentArtifacts: { type: 'number' },
          },
          required: ['deletedObjects', 'deletedDocumentArtifacts'],
        },
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = userStorageCleanupSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    return cleanupUserStorageArtifacts({ storage, s3Prefix, ...parsed.data });
  });
}

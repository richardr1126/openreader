import { clearTtsPlaybackArtifacts } from '../../playback/cache-clear';
import type { TtsPlaybackResetScope, TtsPlaybackStorage } from '../../playback/storage';
import { ttsPlaybackResetScopeFromOperationKey } from '../../operations/keys';
import { cleanupUserStorageArtifacts } from '../../storage/user-storage-cleanup';
import { collectStorageUsage, reclaimableVariants } from '../../storage/storage-usage';
import { invalidatePlaybackOperationsForScope } from '../playback/operation-invalidation';
import type { PlaybackSessionReadModel } from '../playback/session-read-model';
import type { ComputeWorkerRouteContext } from '../route-context';
import {
  apiErrorResponseSchema,
  jsonSchema,
  ttsPlaybackCacheClearSchema,
  ttsPlaybackCacheReclaimResponseSchema,
  ttsPlaybackCacheReclaimSchema,
  userStorageCleanupSchema,
  userStorageUsageResponseSchema,
  userStorageUsageSchema,
} from '../schemas';

const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

export function registerCleanupRoutes(
  context: ComputeWorkerRouteContext,
  readModel: PlaybackSessionReadModel,
) {
  const { app, deps, storage, playbackStorage, s3Prefix } = context;

  // Stop everything that could still write into a scope: bump its epoch,
  // cancel sessions, drop cached sidecars and fail in-flight operations.
  const cancelPlaybackScope = async (
    playbackStorage: TtsPlaybackStorage,
    scope: TtsPlaybackResetScope,
    now: number,
    timed: <T>(phase: string, run: () => Promise<T>) => Promise<T> = (_phase, run) => run(),
  ) => {
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
    return { invalidatedPlaybackSessions, invalidatedJobOperations };
  };

  // Documents a user still has playback sessions or export operations for, so
  // account cleanup can cancel them before deleting the user's objects.
  const listUserPlaybackDocumentIds = async (
    playbackStorage: TtsPlaybackStorage,
    storageUserId: string,
  ): Promise<string[]> => {
    const documentIds = new Set<string>();
    for (const session of await playbackStorage.sessions.listSessions()) {
      if (session.storageUserId === storageUserId) documentIds.add(session.documentId);
    }
    for (const state of await deps.operationStateStore.listOpStates?.() ?? []) {
      const keyScope = ttsPlaybackResetScopeFromOperationKey(state.opKey);
      if (keyScope?.storageUserId === storageUserId) documentIds.add(keyScope.documentId);
    }
    return [...documentIds];
  };

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
    const { invalidatedPlaybackSessions, invalidatedJobOperations } = await cancelPlaybackScope(
      playbackStorage, scope, now, timed,
    );
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

  const cleanupUserStorage = async (input: typeof userStorageCleanupSchema._output) => {
    if (playbackStorage && input.namespace === null) {
      const now = Date.now();
      for (const documentId of await listUserPlaybackDocumentIds(playbackStorage, input.storageUserId)) {
        await cancelPlaybackScope(playbackStorage, { storageUserId: input.storageUserId, documentId }, now);
      }
    }
    return cleanupUserStorageArtifacts({ storage, s3Prefix, ...input });
  };

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
    return cleanupUserStorage(parsed.data);
  });

  return {
    cleanupUserStorage,
    clearPlaybackScope: async (scope: TtsPlaybackResetScope) => {
      if (!playbackStorage) throw new Error('Playback storage is required for cleanup');
      return resetPlaybackScope(playbackStorage, crypto.randomUUID(), scope, { namespace: null });
    },
  };
}

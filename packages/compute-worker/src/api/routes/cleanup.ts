import { clearTtsPlaybackArtifacts } from '../../playback/cache-clear';
import {
  clearDocumentPreviewArtifacts,
  clearPdfLayoutArtifacts,
  clearTtsPlaybackPlanArtifacts,
} from '../../storage/document-derived-cleanup';
import { ttsPlaybackPlanArtifactPrefix } from '../../storage/artifact-addressing';
import { cleanupUserStorageArtifacts } from '../../storage/user-storage-cleanup';
import { invalidatePlaybackOperationsForScope } from '../playback/operation-invalidation';
import type { PlaybackSessionReadModel } from '../playback/session-read-model';
import type { ComputeWorkerRouteContext } from '../route-context';
import {
  apiErrorResponseSchema,
  documentPreviewClearSchema,
  jsonSchema,
  pdfLayoutClearSchema,
  ttsPlaybackCacheClearSchema,
  ttsPlaybackPlansClearSchema,
  userStorageCleanupSchema,
} from '../schemas';

const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

export function registerCleanupRoutes(
  context: ComputeWorkerRouteContext,
  readModel: PlaybackSessionReadModel,
): void {
  const { app, deps, storage, playbackStorage, s3Prefix } = context;

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
    if (!playbackStorage) {
      reply.code(503);
      return { error: 'TTS playback storage is unavailable' };
    }
    const { namespace, readerType, ...scope } = parsed.data;
    const now = Date.now();
    await playbackStorage.artifacts.incrementScopeEpoch(scope, now);
    const invalidatedPlaybackSessions = await playbackStorage.sessions.cancelSessionsForScope(scope, now);
    readModel.invalidateSidecarsForScope(scope);
    const invalidatedJobOperations = await invalidatePlaybackOperationsForScope({
      scope,
      now,
      operationStateStore: deps.operationStateStore,
      orchestrator: deps.orchestrator,
      readSession: readModel.readSession,
    });
    const deleted = await clearTtsPlaybackArtifacts({
      storage,
      s3Prefix,
      scope: { ...scope, namespace, ...(readerType ? { readerType } : {}) },
    });
    return { ...deleted, invalidatedPlaybackSessions, invalidatedJobOperations };
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

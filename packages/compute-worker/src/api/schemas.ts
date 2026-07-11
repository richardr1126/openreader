import { z } from 'zod';

const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const parsedPdfBlockKindSchema = z.enum([
  'abstract', 'algorithm', 'aside_text', 'chart', 'content', 'formula',
  'doc_title', 'figure_title', 'footer', 'footnote', 'formula_number',
  'header', 'image', 'number', 'paragraph_title', 'reference',
  'reference_content', 'seal', 'table', 'text', 'vision_footnote',
]);
const documentIdSchema = z.string().trim().regex(/^[a-f0-9]{64}$/i);
const namespaceSchema = z.string().trim().regex(/^[a-zA-Z0-9._-]{1,128}$/).nullable();

export const parsedPdfDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  documentId: z.string(),
  parserVersion: z.string(),
  parsedAt: z.number(),
  pages: z.array(z.object({
    pageNumber: z.number(),
    width: z.number(),
    height: z.number(),
    blocks: z.array(z.object({
      id: z.string(),
      kind: parsedPdfBlockKindSchema,
      fragments: z.array(z.object({
        page: z.number(),
        bbox: bboxSchema,
        text: z.string(),
        readingOrder: z.number(),
        modelConfidence: z.number().optional(),
      })),
      text: z.string(),
      parentSectionId: z.string().optional(),
    })),
  })),
});

export const ttsSentenceAlignmentSchema = z.object({
  sentence: z.string(),
  sentenceIndex: z.number(),
  words: z.array(z.object({
    text: z.string(),
    startSec: z.number(),
    endSec: z.number(),
    charStart: z.number(),
    charEnd: z.number(),
  })),
});

export const pdfOperationCreateSchema = z.object({
  documentId: documentIdSchema,
  namespace: namespaceSchema,
  documentObjectKey: z.string().trim().min(1).max(2048),
  replaceToken: z.string().trim().min(1).max(256).optional(),
});

export const documentPreviewOperationCreateSchema = z.object({
  documentId: documentIdSchema,
  namespace: namespaceSchema,
  documentType: z.enum(['pdf', 'epub']),
  sourceObjectKey: z.string().trim().min(1).max(2048),
  sourceLastModifiedMs: z.number().int().nonnegative(),
  previewKind: z.literal('card'),
  rendererVersion: z.string().trim().min(1).max(256).optional(),
  targetWidth: z.number().int().positive().max(2048).optional(),
}).strict();

export const documentPreviewResolveSchema = documentPreviewOperationCreateSchema.omit({
  targetWidth: true,
});

export const documentConversionOperationCreateSchema = z.object({
  conversionId: z.string().trim().regex(/^[a-f0-9]{8,128}$/i),
  namespace: namespaceSchema,
  sourceObjectKey: z.string().trim().min(1).max(2048),
  sourceLastModifiedMs: z.number().int().nonnegative(),
  sourceContentType: z.string().trim().min(1).max(256),
  sourceEtag: z.string().trim().min(1).max(256).nullable().optional(),
  converterVersion: z.string().trim().min(1).max(256).optional(),
}).strict();

export const documentConversionResolveSchema = documentConversionOperationCreateSchema;

export const accountExportOperationCreateSchema = z.object({
  artifactId: z.string().trim().regex(/^[a-f0-9]{8,128}$/i),
  userId: z.string().trim().min(1).max(256),
  storageUserId: z.string().trim().min(1).max(256),
  namespace: namespaceSchema,
  schemaVersion: z.number().int().positive(),
  manifestHash: z.string().trim().regex(/^[a-f0-9]{64}$/i),
  manifestObjectKey: z.string().trim().min(1).max(2048),
}).strict();

export const accountExportResolveSchema = accountExportOperationCreateSchema.pick({
  artifactId: true,
  storageUserId: true,
  namespace: true,
  schemaVersion: true,
  manifestHash: true,
});

export const ttsPlaybackPlanningSchema = z.object({
  selectedOrdinal: z.number().int().nonnegative().optional(),
  maxBlockLength: z.number().int().positive().max(20_000).optional(),
  enforceSourceBoundaries: z.boolean().optional(),
  language: z.string().trim().min(1).max(32).optional(),
  documentSource: z.object({
    namespace: z.string().trim().min(1).max(128).nullable(),
    skipBlockKinds: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
    extent: z.enum(['section', 'document']),
    isPlainText: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export const ttsPlaybackPlanOperationCreateSchema = z.object({
  userId: z.string().trim().min(1).max(256),
  storageUserId: z.string().trim().min(1).max(256),
  documentId: documentIdSchema,
  documentVersion: z.number().int().nonnegative(),
  readerType: z.enum(['pdf', 'epub', 'html']),
  settingsHash: z.string().trim().min(1).max(256),
  settingsJson: z.unknown(),
  planning: ttsPlaybackPlanningSchema,
}).strict();

export const ttsPlaybackOperationCreateSchema = ttsPlaybackPlanOperationCreateSchema.extend({
  sessionId: z.string().trim().min(1).max(128),
  planObjectKey: z.string().trim().min(1).max(2048),
  generationRunId: z.string().trim().min(1).max(128).optional(),
  expiresAt: z.number().int().positive().optional(),
  aheadWindow: z.number().int().positive().max(4096).optional(),
  backgroundExtent: z.enum(['section', 'document']).optional(),
  generationExtent: z.enum(['window', 'document']).optional(),
}).strict();

export const ttsPlaybackCursorUpdateSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive().optional(),
});

export const ttsPlaybackResetSchema = z.object({
  storageUserId: z.string().trim().min(1).max(256),
  documentId: documentIdSchema,
  documentVersion: z.number().int().nonnegative().optional(),
  settingsHash: z.string().trim().min(1).max(256).optional(),
});

export const ttsPlaybackSessionResolveSchema = z.object({
  storageUserId: z.string().trim().min(1).max(256),
  documentId: documentIdSchema,
  documentVersion: z.number().int().nonnegative(),
  readerType: z.enum(['pdf', 'epub', 'html']),
  settingsHash: z.string().trim().min(1).max(256),
  planObjectKey: z.string().trim().min(1).max(2048),
  purpose: z.enum(['live', 'export-document']),
}).strict();

export const ttsPlaybackCacheClearSchema = ttsPlaybackResetSchema.extend({
  namespace: z.string().trim().min(1).max(128).nullable(),
  readerType: z.enum(['pdf', 'epub', 'html']).optional(),
}).strict();

export const userStorageCleanupSchema = z.object({
  storageUserId: z.string().trim().min(1).max(256),
  namespace: z.string().trim().min(1).max(128).nullable(),
  documentIds: z.array(z.string().trim().regex(/^[a-f0-9]{64}$/i)).max(100),
}).strict();

export const ttsPlaybackExportFormatSchema = z.enum(['mp3', 'm4b']);

export const ttsPlaybackExportArtifactCreateSchema = z.object({
  artifactId: z.string().trim().regex(/^[a-f0-9]{8,128}$/i),
  sessionId: z.string().trim().min(1).max(128),
  userId: z.string().trim().min(1).max(256),
  storageUserId: z.string().trim().min(1).max(256),
  documentId: documentIdSchema,
  documentVersion: z.number().int().nonnegative(),
  readerType: z.enum(['pdf', 'epub', 'html']),
  settingsHash: z.string().trim().min(1).max(256),
  settingsJson: z.unknown(),
  planObjectKey: z.string().trim().min(1).max(2048),
  format: ttsPlaybackExportFormatSchema,
  speed: z.number().min(0.5).max(3),
}).strict();

export const ttsPlaybackExportArtifactResolveSchema = z.object({
  artifactId: z.string().trim().regex(/^[a-f0-9]{8,128}$/i),
  documentId: documentIdSchema,
  documentVersion: z.number().int().nonnegative(),
  settingsHash: z.string().trim().min(1).max(256),
  format: ttsPlaybackExportFormatSchema,
  speed: z.number().min(0.5).max(3),
}).strict();

export const pdfResolveSchema = z.object({
  documentId: documentIdSchema,
  namespace: namespaceSchema,
  documentObjectKey: z.string().trim().min(1).max(2048),
});

export const operationParamsSchema = z.object({
  opId: z.string().trim().min(1),
});

export const operationEventsQuerySchema = z.object({
  sinceEventId: z.union([z.string(), z.number()]).optional(),
});

export const apiErrorResponseSchema = z.object({
  error: z.string(),
}).passthrough();

export const operationErrorSchema = z.object({
  message: z.string(),
  code: z.string().optional(),
});

export const artifactReferenceSchema = z.object({
  objectKey: z.string(),
});

export const pdfLayoutProgressSchema = z.object({
  totalPages: z.number(),
  pagesParsed: z.number(),
  currentPage: z.number().optional(),
  phase: z.enum(['infer', 'merge']),
});

export const ttsPlaybackProgressSchema = z.object({
  completedThroughOrdinal: z.number(),
  completedCount: z.number(),
  plannedCount: z.number(),
});

export const ttsPlaybackExportProgressSchema = z.object({
  phase: z.enum(['assembling', 'transcoding', 'uploading']),
  completedSegments: z.number(),
  plannedSegments: z.number(),
});

export const documentConversionProgressSchema = z.object({
  phase: z.enum(['fetching', 'converting', 'uploading']),
});

export const accountExportProgressSchema = z.object({
  phase: z.enum(['assembling', 'uploading']),
  completedFiles: z.number(),
  plannedFiles: z.number(),
});

export const ttsPlaybackExportArtifactMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  artifactId: z.string(),
  sessionId: z.string(),
  storageUserId: z.string(),
  documentId: z.string(),
  documentVersion: z.number(),
  readerType: z.enum(['pdf', 'epub', 'html']),
  settingsHash: z.string(),
  planObjectKey: z.string(),
  format: ttsPlaybackExportFormatSchema,
  speed: z.number(),
  objectKey: z.string(),
  contentType: z.string(),
  byteLength: z.number(),
  dispositionFilename: z.string(),
  sourceSessionId: z.string(),
  sourcePlanObjectKey: z.string(),
  status: z.literal('ready'),
  createdAt: z.number(),
});

export const documentPreviewArtifactMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  documentId: z.string(),
  namespace: z.string().nullable(),
  documentType: z.enum(['pdf', 'epub']),
  sourceObjectKey: z.string(),
  sourceLastModifiedMs: z.number(),
  previewKind: z.literal('card'),
  rendererVersion: z.string(),
  objectKey: z.string(),
  metadataObjectKey: z.string(),
  contentType: z.literal('image/jpeg'),
  width: z.number(),
  height: z.number().nullable(),
  byteLength: z.number(),
  eTag: z.string().nullable(),
  status: z.literal('ready'),
  createdAt: z.number(),
});

export const documentConversionArtifactMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  conversionId: z.string(),
  namespace: z.string().nullable(),
  sourceObjectKey: z.string(),
  sourceLastModifiedMs: z.number(),
  sourceContentType: z.string(),
  sourceEtag: z.string().nullable(),
  converterVersion: z.string(),
  objectKey: z.string(),
  metadataObjectKey: z.string(),
  contentType: z.literal('application/pdf'),
  byteLength: z.number(),
  documentId: z.string(),
  status: z.literal('ready'),
  createdAt: z.number(),
});

export const accountExportArtifactMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  artifactId: z.string(),
  userId: z.string(),
  storageUserId: z.string(),
  namespace: z.string().nullable(),
  exportSchemaVersion: z.number(),
  manifestHash: z.string(),
  manifestObjectKey: z.string(),
  objectKey: z.string(),
  contentType: z.literal('application/zip'),
  byteLength: z.number(),
  dispositionFilename: z.string(),
  status: z.literal('ready'),
  createdAt: z.number(),
});


export const computeOperationSchema = z.object({
  opId: z.string(),
  subject: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('pdf_layout'),
      documentId: z.string(),
      namespace: z.string().nullable(),
    }),
    z.object({
      kind: z.literal('tts_playback'),
      documentId: z.string(),
      sessionId: z.string(),
    }),
    z.object({
      kind: z.literal('tts_playback_plan'),
      documentId: z.string(),
      settingsHash: z.string(),
      planSignature: z.string(),
    }),
    z.object({
      kind: z.literal('tts_playback_export'),
      documentId: z.string(),
      artifactId: z.string(),
      format: ttsPlaybackExportFormatSchema,
    }),
    z.object({
      kind: z.literal('document_preview'),
      documentId: z.string(),
      namespace: z.string().nullable(),
      previewKind: z.literal('card'),
    }),
    z.object({
      kind: z.literal('document_conversion'),
      conversionId: z.string(),
      namespace: z.string().nullable(),
    }),
    z.object({
      kind: z.literal('account_export'),
      storageUserId: z.string(),
      namespace: z.string().nullable(),
      artifactId: z.string(),
    }),
  ]),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  queuedAt: z.number(),
  updatedAt: z.number(),
  startedAt: z.number().optional(),
  result: z.unknown().optional(),
  error: operationErrorSchema.optional(),
  timing: z.object({
    queueWaitMs: z.number().optional(),
    s3FetchMs: z.number().optional(),
    computeMs: z.number().optional(),
  }).optional(),
  progress: z.union([
    pdfLayoutProgressSchema,
    ttsPlaybackProgressSchema,
    ttsPlaybackExportProgressSchema,
    documentConversionProgressSchema,
    accountExportProgressSchema,
  ]).optional(),
});

export const computeOperationEventSchema = z.object({
  eventId: z.number(),
  snapshot: computeOperationSchema,
});

export const pdfLayoutResolutionSchema = z.object({
  artifact: artifactReferenceSchema.nullable(),
  operation: computeOperationSchema.nullable(),
});

export const ttsPlaybackSessionResolutionSchema = z.object({
  sessionId: z.string(),
  session: z.unknown().nullable(),
  operation: computeOperationSchema.nullable(),
  progress: ttsPlaybackProgressSchema.nullable(),
});

export const ttsPlaybackExportArtifactResolutionSchema = z.object({
  artifact: ttsPlaybackExportArtifactMetadataSchema.nullable(),
  operation: computeOperationSchema.nullable(),
});

export const documentPreviewResolutionSchema = z.object({
  artifact: documentPreviewArtifactMetadataSchema.nullable(),
  operation: computeOperationSchema.nullable(),
});

export const documentConversionResolutionSchema = z.object({
  artifact: documentConversionArtifactMetadataSchema.nullable(),
  operation: computeOperationSchema.nullable(),
});

export const accountExportResolutionSchema = z.object({
  artifact: accountExportArtifactMetadataSchema.nullable(),
  operation: computeOperationSchema.nullable(),
});

export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
}

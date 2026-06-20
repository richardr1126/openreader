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

export const ttsPlaybackOperationCreateSchema = z.object({
  sessionId: z.string().trim().min(1).max(128),
  userId: z.string().trim().min(1).max(256),
  storageUserId: z.string().trim().min(1).max(256),
  documentId: documentIdSchema,
  documentVersion: z.number().int().nonnegative(),
  readerType: z.enum(['pdf', 'epub', 'html']),
  settingsHash: z.string().trim().min(1).max(256),
  settingsJson: z.unknown(),
  startOrdinal: z.number().int().nonnegative().default(0),
  planObjectKey: z.string().trim().min(1).max(2048).optional(),
  aheadWindow: z.number().int().positive().max(4096).optional(),
  backgroundExtent: z.enum(['section', 'document']).optional(),
  planning: z.object({
    startSegmentKey: z.string().trim().min(1).max(512).optional(),
    startText: z.string().trim().min(1).max(20_000).optional(),
    maxBlockLength: z.number().int().positive().max(20_000).optional(),
    enforceSourceBoundaries: z.boolean().optional(),
    language: z.string().trim().min(1).max(32).optional(),
    documentSource: z.object({
      namespace: z.string().trim().min(1).max(128).nullable(),
      skipBlockKinds: z.array(z.string().trim().min(1).max(64)).max(64).optional(),
      extent: z.enum(['section', 'document']),
      startPage: z.number().int().positive().optional(),
      startSpineIndex: z.number().int().nonnegative().optional(),
      startCharOffset: z.number().int().nonnegative().optional(),
      isPlainText: z.boolean().optional(),
    }).optional(),
  }),
});

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
  progress: pdfLayoutProgressSchema.optional(),
});

export const computeOperationEventSchema = z.object({
  eventId: z.number(),
  snapshot: computeOperationSchema,
});

export const pdfLayoutResolutionSchema = z.object({
  artifact: artifactReferenceSchema.nullable(),
  operation: computeOperationSchema.nullable(),
});

export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
}

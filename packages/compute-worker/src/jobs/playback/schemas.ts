import { z } from 'zod';

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

export const ttsPlaybackPlanRequestSchema = z.object({
  userId: z.string().trim().min(1).max(256),
  storageUserId: z.string().trim().min(1).max(256),
  documentId: z.string().trim().min(1),
  documentVersion: z.number().int().nonnegative(),
  readerType: z.enum(['pdf', 'epub', 'html']),
  settingsHash: z.string().trim().min(1).max(256),
  settingsJson: z.unknown(),
  planning: ttsPlaybackPlanningSchema,
}).strict();

export const ttsPlaybackRequestSchema = ttsPlaybackPlanRequestSchema.extend({
  sessionId: z.string().trim().min(1).max(128),
  planObjectKey: z.string().trim().min(1).max(2048),
  generationRunId: z.string().trim().min(1).max(128).optional(),
  expiresAt: z.number().int().positive().optional(),
  aheadWindow: z.number().int().positive().max(4096).optional(),
  backgroundExtent: z.enum(['section', 'document']).optional(),
  generationExtent: z.enum(['window', 'document']).optional(),
}).strict();

export const ttsPlaybackExportArtifactRequestSchema = z.object({
  artifactId: z.string().trim().regex(/^[a-f0-9]{8,128}$/i),
  sessionId: z.string().trim().min(1).max(128),
  userId: z.string().trim().min(1).max(256),
  storageUserId: z.string().trim().min(1).max(256),
  documentId: z.string().trim().min(1),
  documentVersion: z.number().int().nonnegative(),
  readerType: z.enum(['pdf', 'epub', 'html']),
  settingsHash: z.string().trim().min(1).max(256),
  settingsJson: z.unknown(),
  planObjectKey: z.string().trim().min(1).max(2048),
  format: z.enum(['mp3', 'm4b']),
  speed: z.number().min(0.5).max(3),
}).strict();

export type TtsPlaybackRequest = z.infer<typeof ttsPlaybackRequestSchema>;
export type TtsPlaybackPlanCapableRequest = z.infer<typeof ttsPlaybackPlanRequestSchema> & {
  sessionId: string;
  planObjectKey?: string;
};

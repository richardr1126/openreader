import { z } from 'zod';
import {
  runPdfLayoutFromPdfBuffer,
  runWhisperAlignmentFromAudioBuffer,
} from '../inference/runtime';
import { withIdleTimeoutAndHardCap, withTimeout } from '../infrastructure/config';
import type {
  PdfLayoutJobRequest,
  PdfLayoutJobResult,
  PdfLayoutProgress,
  WhisperAlignJobRequest,
  WhisperAlignJobResult,
} from '../api/contracts';
import type { ArtifactStorage } from '../infrastructure/storage';
import { persistParsedPdfWhileSourceExists } from './pdf-artifact-persistence';
import { buildInferProgressForPageParsed, buildInferProgressForPageStart } from './pdf-progress';

const whisperRequestSchema = z.object({
  text: z.string().trim().min(1),
  lang: z.string().trim().min(1).max(16).optional(),
  cacheKey: z.string().trim().min(1).max(256).optional(),
  audioObjectKey: z.string().trim().min(1).max(2048),
});

const pdfRequestSchema = z.object({
  documentId: z.string().trim().min(1),
  namespace: z.string().trim().min(1).max(128).nullable(),
  documentObjectKey: z.string().trim().min(1).max(2048),
});

export interface JobHandlers {
  runWhisper(payload: WhisperAlignJobRequest, queueWaitMs: number): Promise<WhisperAlignJobResult>;
  runPdfLayout(
    payload: PdfLayoutJobRequest,
    queueWaitMs: number,
    hooks?: { onProgress?: (progress: PdfLayoutProgress) => Promise<void> },
  ): Promise<PdfLayoutJobResult>;
}

export function createJobHandlers(input: {
  storage: ArtifactStorage;
  whisperTimeoutMs: number;
  pdfTimeoutMs: number;
  pdfHardCapMs: number;
}): JobHandlers {
  return {
    async runWhisper(payload, queueWaitMs) {
      const parsed = whisperRequestSchema.parse(payload);
      const s3FetchStartedAt = Date.now();
      const audioBuffer = await withTimeout(
        input.storage.readObject(parsed.audioObjectKey),
        input.whisperTimeoutMs,
        'whisper s3 fetch',
      );
      const s3FetchMs = Date.now() - s3FetchStartedAt;
      const computeStartedAt = Date.now();
      const result = await withTimeout(
        runWhisperAlignmentFromAudioBuffer({
          audioBuffer,
          text: parsed.text,
          cacheKey: parsed.cacheKey,
          lang: parsed.lang,
        }),
        input.whisperTimeoutMs,
        'whisper alignment job',
      );
      return {
        ...result,
        timing: { queueWaitMs, s3FetchMs, computeMs: Date.now() - computeStartedAt },
      };
    },

    async runPdfLayout(payload, queueWaitMs, hooks) {
      const parsed = pdfRequestSchema.parse(payload);
      const s3FetchStartedAt = Date.now();
      const pdfBytes = await withTimeout(
        input.storage.readObject(parsed.documentObjectKey),
        Math.max(input.pdfTimeoutMs, 1_000),
        'pdf s3 fetch',
      );
      const s3FetchMs = Date.now() - s3FetchStartedAt;
      let lastTotalPages = 0;
      let lastPagesParsed = 0;
      const computeStartedAt = Date.now();
      const result = await withIdleTimeoutAndHardCap({
        idleTimeoutMs: Math.max(input.pdfTimeoutMs, 1_000),
        hardCapMs: input.pdfHardCapMs,
        label: 'pdf layout job',
        run: async (touchProgress) => runPdfLayoutFromPdfBuffer({
          documentId: parsed.documentId,
          pdfBytes,
          onPageStarted: async ({ pageNumber, totalPages }) => {
            touchProgress();
            lastTotalPages = totalPages;
            await hooks?.onProgress?.(buildInferProgressForPageStart({ pageNumber, totalPages }));
          },
          onPageParsed: async ({ pageNumber, totalPages }) => {
            touchProgress();
            lastTotalPages = totalPages;
            lastPagesParsed = pageNumber;
            await hooks?.onProgress?.(buildInferProgressForPageParsed({ pageNumber, totalPages }));
          },
        }),
      });
      const computeMs = Date.now() - computeStartedAt;
      if (hooks?.onProgress && lastTotalPages > 0) {
        await hooks.onProgress({
          totalPages: lastTotalPages,
          pagesParsed: lastPagesParsed,
          currentPage: lastPagesParsed || undefined,
          phase: 'merge',
        });
      }
      const parsedObjectKey = await persistParsedPdfWhileSourceExists({
        sourceObjectKey: parsed.documentObjectKey,
        sourceExists: input.storage.objectExists,
        putParsedObject: () => input.storage.putParsedPdf(parsed.documentId, parsed.namespace, result.parsed),
        deleteParsedObject: input.storage.deleteObject,
      });
      return {
        parsedObjectKey,
        timing: { queueWaitMs, s3FetchMs, computeMs },
      };
    },
  };
}

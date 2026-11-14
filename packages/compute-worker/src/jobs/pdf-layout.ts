import { z } from 'zod';
import { runPdfLayoutFromPdfBuffer } from '../inference/runtime';
import { withIdleTimeoutAndHardCap, withTimeout } from '../infrastructure/config';
import type { PdfLayoutJobRequest, PdfLayoutJobResult, PdfLayoutProgress } from '../operations/contracts';
import type { JobHandlerContext } from './context';
import { createModelDownloadProgressReporter } from './model-download-progress';
import { persistParsedPdfWhileSourceExists } from './pdf-artifact-persistence';
import {
  clearPdfParseCheckpoint,
  readPdfParseCheckpoint,
  writePdfParseCheckpointChunk,
} from '../storage/pdf-parse-checkpoint';
import { buildInferProgressForPageParsed, buildInferProgressForPageStart } from './pdf-progress';

const requestSchema = z.object({
  documentId: z.string().trim().min(1),
  namespace: z.string().trim().min(1).max(128).nullable(),
  documentObjectKey: z.string().trim().min(1).max(2048),
});

export function createPdfLayoutHandler(input: JobHandlerContext) {
  return async function runPdfLayout(
    payload: PdfLayoutJobRequest,
    queueWaitMs: number,
    hooks?: { onProgress?: (progress: PdfLayoutProgress) => Promise<void> },
  ): Promise<PdfLayoutJobResult> {
    const parsed = requestSchema.parse(payload);
    const checkpointScope = {
      storage: input.storage,
      documentId: parsed.documentId,
      namespace: parsed.namespace,
      prefix: input.s3Prefix,
      sourceObjectKey: parsed.documentObjectKey,
    };
    const s3FetchStartedAt = Date.now();
    const pdfBytes = await withTimeout(input.storage.readObject(parsed.documentObjectKey), Math.max(input.pdfTimeoutMs, 1_000), 'pdf s3 fetch');
    const s3FetchMs = Date.now() - s3FetchStartedAt;
    let lastTotalPages = 0;
    let lastPagesParsed = 0;
    // Work an earlier run finished before it was interrupted. A checkpoint that
    // cannot be read is not worth failing a parse over: it only means starting
    // from the first page, which is what every run did before checkpoints.
    const resume = await readPdfParseCheckpoint(checkpointScope).catch((error) => {
      input.logger?.warn({
        documentId: parsed.documentId,
        error: error instanceof Error ? error.message : String(error),
      }, 'pdf layout checkpoint could not be read; parsing from the first page');
      return null;
    });
    input.logger?.info?.({
      documentId: parsed.documentId,
      resumedFromPage: resume ? resume.pages.length + 1 : 1,
    }, resume ? 'pdf layout resuming from checkpoint' : 'pdf layout starting from the first page');
    if (resume) lastPagesParsed = resume.pages.length;
    const computeStartedAt = Date.now();
    const result = await withIdleTimeoutAndHardCap({
      idleTimeoutMs: Math.max(input.pdfTimeoutMs, 1_000),
      hardCapMs: input.pdfHardCapMs,
      label: 'pdf layout job',
      run: async (touchProgress) => runPdfLayoutFromPdfBuffer({
        documentId: parsed.documentId,
        pdfBytes,
        resume,
        // Losing a chunk costs a few pages of rework, so a failed write is
        // reported and the parse carries on rather than being thrown away.
        onPagesCompleted: async ({ pages, startPage, totalPages, sawText }) => {
          touchProgress();
          await writePdfParseCheckpointChunk({
            ...checkpointScope, pages, startPage, totalPages, sawText,
          }).then(() => input.logger?.info?.({
            documentId: parsed.documentId,
            startPage,
            throughPage: startPage + pages.length - 1,
            totalPages,
          }, 'pdf layout checkpointed pages')).catch((error) => input.logger?.warn({
            documentId: parsed.documentId,
            startPage,
            error: error instanceof Error ? error.message : String(error),
          }, 'pdf layout checkpoint chunk could not be written'));
        },
        onModelDownloadProgress: createModelDownloadProgressReporter({
          onObserved: touchProgress,
          publish: async ({ downloadedBytes, totalBytes }) => {
            await hooks?.onProgress?.({
              phase: 'download_model',
              totalPages: 0,
              pagesParsed: 0,
              downloadedBytes,
              totalBytes,
            });
          },
        }),
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
    // The artifact is durable, so the pages that built it are only cost now.
    await clearPdfParseCheckpoint(checkpointScope).catch((error) => input.logger?.warn({
      documentId: parsed.documentId,
      error: error instanceof Error ? error.message : String(error),
    }, 'pdf layout checkpoint could not be cleared'));
    return { parsedObjectKey, timing: { queueWaitMs, s3FetchMs, computeMs } };
  };
}

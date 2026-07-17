import { z } from 'zod';
import { runPdfLayoutFromPdfBuffer } from '../inference/runtime';
import { withIdleTimeoutAndHardCap, withTimeout } from '../infrastructure/config';
import type { PdfLayoutJobRequest, PdfLayoutJobResult, PdfLayoutProgress } from '../operations/contracts';
import type { JobHandlerContext } from './context';
import { persistParsedPdfWhileSourceExists } from './pdf-artifact-persistence';
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
    const s3FetchStartedAt = Date.now();
    const pdfBytes = await withTimeout(input.storage.readObject(parsed.documentObjectKey), Math.max(input.pdfTimeoutMs, 1_000), 'pdf s3 fetch');
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
    return { parsedObjectKey, timing: { queueWaitMs, s3FetchMs, computeMs } };
  };
}

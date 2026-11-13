import { z } from 'zod';
import { runPdfLayoutFromPdfBuffer } from '../inference/runtime';
import { withIdleTimeoutAndHardCap } from '../infrastructure/config';
import type { PdfLayoutJobRequest, PdfLayoutJobResult, PdfLayoutProgress } from '../operations/contracts';
import { parsedPdfArtifactKey } from '../storage/artifact-addressing';
import { createPdfParseCheckpoint } from '../storage/pdf-parse-checkpoint';
import type { PdfLayoutJobContext } from './context';
import { createModelDownloadProgressReporter } from './model-download-progress';
import { persistParsedPdfWhileSourceExists } from './pdf-artifact-persistence';
import { buildInferProgressForPageParsed, buildInferProgressForPageStart } from './pdf-progress';

const CHECKPOINT_IO_TIMEOUT_MS = 15_000;

const requestSchema = z.object({
  documentId: z.string().trim().min(1),
  namespace: z.string().trim().min(1).max(128).nullable(),
  documentObjectKey: z.string().trim().min(1).max(2048),
});

export interface PdfLayoutExecution {
  opId: string;
  operationKey: string;
  attempt: number;
  signal: AbortSignal;
  assertActive: () => Promise<void>;
  onProgress: (progress: PdfLayoutProgress) => Promise<void>;
}

export function createPdfLayoutHandler(input: PdfLayoutJobContext) {
  return async function runPdfLayout(
    payload: PdfLayoutJobRequest,
    queueWaitMs: number,
    execution: PdfLayoutExecution,
  ): Promise<PdfLayoutJobResult> {
    const parsed = requestSchema.parse(payload);
    const ioSignal = (timeoutMs: number) => AbortSignal.any([
      execution.signal, AbortSignal.timeout(timeoutMs),
    ]);
    const artifactScope = { ...parsed, prefix: input.s3Prefix };
    const storageSignal = () => ioSignal(CHECKPOINT_IO_TIMEOUT_MS);
    const revision = await input.storage.getParsedPdfRevision(parsed.documentId, parsed.namespace, storageSignal());
    const resultKey = parsedPdfArtifactKey(artifactScope);
    const s3FetchStartedAt = Date.now();
    const pdfBytes = await input.storage.readObject(parsed.documentObjectKey, ioSignal(Math.max(input.pdfTimeoutMs, 1_000)));
    const s3FetchMs = Date.now() - s3FetchStartedAt;
    const checkpoint = createPdfParseCheckpoint({
      ...artifactScope, storage: input.storage, operationKey: execution.operationKey, pdfBytes,
    });
    const clearCheckpoint = () => checkpoint.clear(storageSignal()).catch((error) => {
      input.logger?.warn({ documentId: parsed.documentId, error: String(error) }, 'PDF checkpoint cleanup failed');
    });
    if (revision?.operationId === execution.opId) {
      await execution.assertActive();
      await clearCheckpoint();
      return { parsedObjectKey: resultKey, timing: { queueWaitMs, s3FetchMs } };
    }
    const resume = await checkpoint.read(storageSignal()).catch((error) => {
      execution.signal.throwIfAborted();
      input.logger?.warn({ documentId: parsed.documentId, error: String(error) }, 'PDF checkpoint read failed');
      return null;
    });
    const parseLifetime = new AbortController();
    const computeStartedAt = Date.now();
    const result = await withIdleTimeoutAndHardCap({
      idleTimeoutMs: Math.max(input.pdfTimeoutMs, 1_000),
      hardCapMs: input.pdfHardCapMs,
      label: 'pdf layout job',
      run: async (touchProgress) => runPdfLayoutFromPdfBuffer({
        documentId: parsed.documentId,
        pdfBytes,
        resume,
        onPagesCompleted: async (chunk) => {
          parseLifetime.signal.throwIfAborted();
          await execution.assertActive();
          const signal = AbortSignal.any([parseLifetime.signal, storageSignal()]);
          const key = checkpoint.key(chunk, execution.opId, execution.attempt);
          try {
            if (!await input.storage.objectExists(parsed.documentObjectKey, signal)) return;
            await checkpoint.write(key, chunk, signal);
            if (!await input.storage.objectExists(parsed.documentObjectKey, signal)) {
              await input.storage.deleteObject(key, AbortSignal.timeout(CHECKPOINT_IO_TIMEOUT_MS));
            }
          } catch (error) {
            input.logger?.warn({ documentId: parsed.documentId, error: String(error) }, 'PDF checkpoint write failed');
          }
        },
        onModelDownloadProgress: createModelDownloadProgressReporter({
          onObserved: touchProgress,
          publish: async ({ downloadedBytes, totalBytes }) => {
            parseLifetime.signal.throwIfAborted();
            await execution.onProgress({
              phase: 'download_model',
              totalPages: 0,
              pagesParsed: 0,
              downloadedBytes,
              totalBytes,
            });
          },
        }),
        onPageStarted: async ({ pageNumber, totalPages }) => {
          parseLifetime.signal.throwIfAborted();
          touchProgress();
          await execution.onProgress(buildInferProgressForPageStart({ pageNumber, totalPages }));
        },
        onPageParsed: async ({ pageNumber, totalPages }) => {
          parseLifetime.signal.throwIfAborted();
          touchProgress();
          await execution.onProgress(buildInferProgressForPageParsed({ pageNumber, totalPages }));
        },
      }),
    }).finally(() => parseLifetime.abort());
    const computeMs = Date.now() - computeStartedAt;
    const totalPages = result.parsed.pages.length;
    await execution.onProgress({ totalPages, pagesParsed: totalPages, currentPage: totalPages, phase: 'merge' });
    const parsedObjectKey = await persistParsedPdfWhileSourceExists({
      sourceObjectKey: parsed.documentObjectKey,
      sourceExists: (key) => input.storage.objectExists(key, storageSignal()),
      putParsedObject: async () => {
        await execution.assertActive();
        try {
          return await input.storage.putParsedPdf(parsed.documentId, parsed.namespace, result.parsed, {
            operationId: execution.opId, expected: revision, signal: ioSignal(Math.max(input.pdfTimeoutMs, 1_000)),
          });
        } catch (error) {
          const current = await input.storage.getParsedPdfRevision(parsed.documentId, parsed.namespace, storageSignal());
          if (current?.operationId === execution.opId) return resultKey;
          throw error;
        }
      },
      deleteParsedObject: (key) => input.storage.deleteObject(key, storageSignal()),
    });
    await clearCheckpoint();
    return { parsedObjectKey, timing: { queueWaitMs, s3FetchMs, computeMs } };
  };
}

import type { ComputeOperation, PdfLayoutResult } from '@/lib/server/compute-worker/protocol';
import { pdfParseSnapshotFromWorkerState } from '@/lib/server/pdf-parse/snapshot';
import type { ReaderBootstrapResolution } from './bootstrap';

/** Project an already-authorized worker snapshot without re-reading the database or worker. */
export function resolvePdfOperationReadiness(
  operation: ComputeOperation<PdfLayoutResult>,
): ReaderBootstrapResolution | null {
  const snapshot = pdfParseSnapshotFromWorkerState(operation);
  if (snapshot.parseStatus === 'ready') return null;
  if (snapshot.parseStatus === 'failed') {
    return {
      result: {
        status: 'error',
        message: snapshot.error || 'PDF structure could not be prepared.',
        retryable: true,
      },
    };
  }
  const progress = snapshot.parseProgress;
  return {
    result: {
      status: 'pending',
      progress: {
        kind: 'pdf-parse',
        phase: snapshot.parseStatus === 'pending'
          ? 'queued'
          : progress?.phase === 'download_model'
            ? 'downloading-model'
            : progress?.phase === 'merge' ? 'merging' : 'parsing',
        pagesParsed: Math.max(0, Number(progress?.pagesParsed ?? 0)),
        totalPages: Math.max(0, Number(progress?.totalPages ?? 0)),
        ...(progress?.phase === 'download_model' ? {
          downloadedBytes: Math.max(0, Number(progress.downloadedBytes ?? 0)),
          totalBytes: Math.max(0, Number(progress.totalBytes ?? 0)),
        } : {}),
      },
    },
    operationId: operation.opId,
  };
}

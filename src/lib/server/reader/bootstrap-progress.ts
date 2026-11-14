import type { ComputeOperation, PdfLayoutResult } from '@/lib/server/compute-worker/protocol';
import { pdfParseSnapshotFromWorkerState } from '@/lib/server/pdf-parse/snapshot';
import type { ReaderBootstrapResolution } from './bootstrap';

/**
 * Worker code for an operation whose worker stopped before it finished. The
 * worker's own diagnostic text names thresholds and reconciliation, which say
 * nothing to a reader waiting on a document.
 */
const ORPHANED_OPERATION_ERROR_CODE = 'WORKER_ORPHANED_OP';

/** Project an already-authorized worker snapshot without re-reading the database or worker. */
export function resolvePdfOperationReadiness(
  operation: ComputeOperation<PdfLayoutResult>,
): ReaderBootstrapResolution | null {
  const snapshot = pdfParseSnapshotFromWorkerState(operation);
  if (snapshot.parseStatus === 'ready') return null;
  if (snapshot.parseStatus === 'failed') {
    const abandoned = operation.error?.code === ORPHANED_OPERATION_ERROR_CODE;
    return {
      result: {
        status: 'error',
        message: abandoned
          ? 'PDF preparation stopped before it finished, because the app or its compute worker restarted.'
          : snapshot.error || 'PDF structure could not be prepared.',
        retryable: true,
        failedPdfOperationId: operation.opId,
        ...(abandoned ? { abandoned: true } : {}),
      },
    };
  }
  const progress = snapshot.parseProgress;
  return {
    result: {
      status: 'pending',
      operationId: operation.opId,
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
  };
}

import type { PdfLayoutJobResult, WorkerOperationState } from '@openreader/compute-core/api-contracts';
import type { PdfParseProgress, PdfParseStatus } from '@/types/parsed-pdf';

export function mapWorkerStatusToParseStatus(status: WorkerOperationState['status']): PdfParseStatus {
  switch (status) {
    case 'queued':
      return 'pending';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'ready';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

export function snapshotFromWorkerState(
  state: WorkerOperationState<PdfLayoutJobResult>,
): { parseStatus: PdfParseStatus; parseProgress: PdfParseProgress | null } {
  const parseStatus = mapWorkerStatusToParseStatus(state.status);
  return {
    parseStatus,
    parseProgress: parseStatus === 'running' ? (state.progress ?? null) : null,
  };
}

export function mergeNonReadyParseSnapshot(input: {
  parseStatus: PdfParseStatus;
  parseProgress: PdfParseProgress | null;
  workerState: WorkerOperationState<PdfLayoutJobResult>;
}): { parseStatus: PdfParseStatus; parseProgress: PdfParseProgress | null } {
  const workerSnapshot = snapshotFromWorkerState(input.workerState);
  if (workerSnapshot.parseStatus === 'ready') {
    return {
      parseStatus: input.parseStatus,
      parseProgress: input.parseProgress,
    };
  }
  return workerSnapshot;
}

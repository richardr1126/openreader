import type { PdfLayoutJobResult, WorkerOperationState } from '@openreader/compute-core/api-contracts';
import type { PdfParseProgress, PdfParseStatus } from '@/types/parsed-pdf';
import type { DocumentParseState } from '@/lib/server/documents/parse-state';

function isInflightWorkerStatus(status: WorkerOperationState['status']): boolean {
  return status === 'queued' || status === 'running';
}

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

export function documentParseStateFromWorkerState(
  state: WorkerOperationState<PdfLayoutJobResult>,
  nowMs = Date.now(),
): DocumentParseState {
  const { parseStatus, parseProgress } = snapshotFromWorkerState(state);
  return {
    status: parseStatus,
    progress: parseStatus === 'pending' || parseStatus === 'running'
      ? parseProgress
      : null,
    updatedAt: nowMs,
    ...(typeof state.opId === 'string' && state.opId.trim() ? { opId: state.opId } : {}),
    ...(typeof state.jobId === 'string' && state.jobId.trim() ? { jobId: state.jobId } : {}),
    ...(parseStatus === 'failed' && state.error?.message ? { error: state.error.message } : {}),
  };
}

export function isWorkerOperationStateStale(
  state: WorkerOperationState<PdfLayoutJobResult>,
  staleMs: number,
  nowMs = Date.now(),
): boolean {
  if (!isInflightWorkerStatus(state.status)) return false;
  if (!Number.isFinite(staleMs) || staleMs <= 0) return false;
  const updatedAt = Number(state.updatedAt ?? 0);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
  return (nowMs - updatedAt) > staleMs;
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

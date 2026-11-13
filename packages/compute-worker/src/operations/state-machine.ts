import { RUNNING_OPERATION_STALE_MS, WORKER_OPERATION_KIND_POLICY } from '../operations/contracts';
import type {
  WorkerJobErrorShape,
  WorkerJobState,
  WorkerOperationKind,
  WorkerOperationRequest,
  WorkerOperationState,
} from '../operations/contracts';

export function isTerminalStatus(status: WorkerJobState): boolean {
  return status === 'succeeded' || status === 'failed';
}

export function isInflightStatus(status: WorkerJobState): boolean {
  return status === 'queued' || status === 'running';
}

export function createErrorShape(error: unknown): WorkerJobErrorShape {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return { message: (error as { message: string }).message };
  }
  return { message: String(error) };
}

export function buildQueuedState(input: {
  request: WorkerOperationRequest;
  opId: string;
  jobId: string;
  queuedAt: number;
}): WorkerOperationState {
  return {
    opId: input.opId,
    opKey: input.request.opKey,
    kind: input.request.kind,
    jobId: input.jobId,
    status: 'queued',
    queuedAt: input.queuedAt,
    updatedAt: input.queuedAt,
  };
}

/**
 * How long an in-flight operation may go without a state write before another
 * request may replace it. A running job heartbeats, so its window is the
 * heartbeat one; a queued job writes nothing until it starts, so it keeps the
 * long queue window.
 */
function inflightStaleMs(status: WorkerJobState, opStaleMs: number): number {
  return status === 'running' ? RUNNING_OPERATION_STALE_MS : opStaleMs;
}

export function explainReplacementReason(input: {
  current: WorkerOperationState;
  requestKind: WorkerOperationKind;
  now: number;
  opStaleMs: number;
}): string {
  if (input.current.kind !== input.requestKind) return 'kind_mismatch';
  const ageMs = input.now - input.current.updatedAt;
  if (
    isInflightStatus(input.current.status)
    && ageMs > inflightStaleMs(input.current.status, input.opStaleMs)
  ) return 'stale_running';
  if (input.current.status === 'failed') return 'failed_prior';
  return `status_${input.current.status}`;
}

export function shouldReuseExistingOperation(input: {
  current: WorkerOperationState;
  requestKind: WorkerOperationKind;
  now: number;
  opStaleMs: number;
}): boolean {
  if (input.current.kind !== input.requestKind) return false;
  if (input.current.status === 'succeeded') {
    return WORKER_OPERATION_KIND_POLICY[input.requestKind].reusesSucceeded;
  }
  if (!isInflightStatus(input.current.status)) return false;
  if (input.current.status === 'queued' && !WORKER_OPERATION_KIND_POLICY[input.requestKind].enforcesQueueDeadline) return true;
  const ageMs = input.now - input.current.updatedAt;
  return ageMs <= inflightStaleMs(input.current.status, input.opStaleMs);
}

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

export function explainReplacementReason(input: {
  current: WorkerOperationState;
  requestKind: WorkerOperationKind;
  now: number;
  opStaleMs: number;
}): string {
  if (input.current.kind !== input.requestKind) return 'kind_mismatch';
  const ageMs = input.now - input.current.updatedAt;
  if (isInflightStatus(input.current.status) && ageMs > input.opStaleMs) return 'stale_running';
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
    // Playback artifacts are the reusable cache, not terminal playback job
    // records. Replacing terminal playback jobs lets live/export requests verify
    // the current sidecar state while still deduping active work.
    return input.requestKind !== 'tts_playback_plan'
      && input.requestKind !== 'tts_playback'
      && input.requestKind !== 'tts_playback_export'
      && input.requestKind !== 'document_preview'
      && input.requestKind !== 'document_conversion';
  }
  if (!isInflightStatus(input.current.status)) return false;
  const ageMs = input.now - input.current.updatedAt;
  return ageMs <= input.opStaleMs;
}

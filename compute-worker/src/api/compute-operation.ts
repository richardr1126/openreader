import type { WorkerOperationState } from '../operations/contracts';
import { pdfSubjectFromOperationKey } from '../operations/keys';

export type ComputeOperationSubject =
  | { kind: 'whisper_align' }
  | { kind: 'pdf_layout'; documentId: string; namespace: string | null };

export interface ComputeOperation<Result = unknown> {
  opId: string;
  subject: ComputeOperationSubject;
  status: WorkerOperationState['status'];
  queuedAt: number;
  updatedAt: number;
  startedAt?: number;
  result?: Result;
  error?: WorkerOperationState['error'];
  timing?: WorkerOperationState['timing'];
  progress?: WorkerOperationState['progress'];
}

export interface ComputeOperationEvent<Result = unknown> {
  eventId: number;
  snapshot: ComputeOperation<Result>;
}

export function toComputeOperation<Result>(
  state: WorkerOperationState<Result>,
): ComputeOperation<Result> {
  const subject = state.kind === 'pdf_layout'
    ? (pdfSubjectFromOperationKey(state.opKey) ?? { kind: 'pdf_layout', documentId: '', namespace: null })
    : { kind: 'whisper_align' as const };
  return {
    opId: state.opId,
    subject,
    status: state.status,
    queuedAt: state.queuedAt,
    updatedAt: state.updatedAt,
    ...(state.startedAt === undefined ? {} : { startedAt: state.startedAt }),
    ...(state.result === undefined ? {} : { result: state.result }),
    ...(state.error === undefined ? {} : { error: state.error }),
    ...(state.timing === undefined ? {} : { timing: state.timing }),
    ...(state.progress === undefined ? {} : { progress: state.progress }),
  };
}

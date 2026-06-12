import type { WorkerOperationState } from '../compute/api-contracts';
import { pdfSubjectFromOperationKey } from './operation-keys';

export type PublicOperationSubject =
  | { kind: 'whisper_align' }
  | { kind: 'pdf_layout'; documentId: string; namespace: string | null };

export interface PublicOperation<Result = unknown> {
  opId: string;
  subject: PublicOperationSubject;
  status: WorkerOperationState['status'];
  queuedAt: number;
  updatedAt: number;
  startedAt?: number;
  result?: Result;
  error?: WorkerOperationState['error'];
  timing?: WorkerOperationState['timing'];
  progress?: WorkerOperationState['progress'];
}

export interface PublicOperationEvent<Result = unknown> {
  eventId: number;
  snapshot: PublicOperation<Result>;
}

export function toPublicOperation<Result>(
  state: WorkerOperationState<Result>,
): PublicOperation<Result> {
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

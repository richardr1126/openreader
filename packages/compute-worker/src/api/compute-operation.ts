import type { WorkerOperationState } from '../operations/contracts';
import {
  pdfSubjectFromOperationKey,
  ttsPlaybackExportSubjectFromOperationKey,
  ttsPlaybackPlanSubjectFromOperationKey,
  ttsPlaybackSubjectFromOperationKey,
} from '../operations/keys';

export type ComputeOperationSubject =
  | { kind: 'pdf_layout'; documentId: string; namespace: string | null }
  | { kind: 'tts_playback'; documentId: string; sessionId: string }
  | { kind: 'tts_playback_plan'; documentId: string; settingsHash: string; planSignature: string }
  | { kind: 'tts_playback_export'; documentId: string; artifactId: string; format: 'mp3' | 'm4b' };

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
    : state.kind === 'tts_playback_plan'
      ? (ttsPlaybackPlanSubjectFromOperationKey(state.opKey) ?? {
        kind: 'tts_playback_plan',
        documentId: '',
        settingsHash: '',
        planSignature: '',
      })
      : state.kind === 'tts_playback_export'
        ? (ttsPlaybackExportSubjectFromOperationKey(state.opKey) ?? {
          kind: 'tts_playback_export',
          documentId: '',
          artifactId: '',
          format: 'mp3',
        })
        : (ttsPlaybackSubjectFromOperationKey(state.opKey) ?? { kind: 'tts_playback', documentId: '', sessionId: '' });
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

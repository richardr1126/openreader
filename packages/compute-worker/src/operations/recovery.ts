import type {
  MaintenanceJobResult,
  PdfLayoutJobResult,
  AccountExportJobResult,
  EmailDeliveryJobResult,
  ModelDownloadJobResult,
  DocumentPreviewJobResult,
  DocumentConversionJobResult,
  TtsPlaybackExportArtifactResult,
  TtsPlaybackPlanJobResult,
  TtsPlaybackJobResult,
  WorkerJobTiming,
  WorkerJobState,
  WorkerOperationState,
} from '../operations/contracts';
import { RUNNING_OPERATION_STALE_MS, WORKER_OPERATION_KIND_POLICY } from './contracts';
import {
  WORKER_RUNNER_IDENTITY,
  outlivedItsRunner,
  type RunnerIdentity,
} from './runner-identity';

export type StreamedOperationState = WorkerOperationState<
  PdfLayoutJobResult | TtsPlaybackJobResult | TtsPlaybackPlanJobResult | TtsPlaybackExportArtifactResult | DocumentPreviewJobResult | DocumentConversionJobResult | AccountExportJobResult | EmailDeliveryJobResult | ModelDownloadJobResult | MaintenanceJobResult
>;

export interface OrphanRecoveryStateStore {
  getOpStateRecord(opId: string): Promise<{ state: StreamedOperationState; revision: number } | null>;
  listOpStates(): Promise<StreamedOperationState[]>;
}

export interface OrphanRecoveryOrchestrator {
  markFailedIfUnchanged(input: {
    current: StreamedOperationState;
    expectedRevision: number;
    error: { message: string; code?: string } | string;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<StreamedOperationState | null>;
}

export interface RecoverOrphanedOperationsInput {
  operationStateStore: OrphanRecoveryStateStore;
  orchestrator: OrphanRecoveryOrchestrator;
  opStaleMs: number;
  nowMs?: number;
  identity?: RunnerIdentity;
}

/**
 * Whether an in-flight operation has stopped being anybody's work: either this
 * process replaced the worker that was running it, which is certain and
 * immediate, or its heartbeat has been silent long enough to be sure.
 */
function isAbandoned(input: {
  state: StreamedOperationState;
  nowMs: number;
  staleAfterMs: number;
  identity: RunnerIdentity;
}): boolean {
  if (outlivedItsRunner({
    runner: input.state.runner,
    updatedAt: input.state.updatedAt,
    identity: input.identity,
  })) return true;
  return input.nowMs - input.state.updatedAt > input.staleAfterMs;
}

export const ORPHANED_OPERATION_ERROR_CODE = 'WORKER_ORPHANED_OP';

function isInflightStatus(status: WorkerJobState): boolean {
  return status === 'queued' || status === 'running';
}

/**
 * How long an in-flight operation may go without a state write before it is
 * treated as abandoned. A running job heartbeats every few seconds whatever it
 * is doing, so a running operation is judged on heartbeat age alone and not on
 * the job's own duration budget: a slow job keeps reporting, while a job whose
 * worker is gone stops reporting immediately.
 */
export function getOrphanRecoveryThresholdMs(input: {
  state: StreamedOperationState;
  opStaleMs: number;
}): number | null {
  if (!isInflightStatus(input.state.status)) return null;
  if (input.state.status === 'queued' && !WORKER_OPERATION_KIND_POLICY[input.state.kind].enforcesQueueDeadline) return null;
  if (input.state.status === 'running') return RUNNING_OPERATION_STALE_MS;
  return input.state.kind === 'pdf_layout'
    || input.state.kind === 'tts_playback_plan'
    || input.state.kind === 'document_preview'
    || input.state.kind === 'document_conversion'
    || input.state.kind === 'account_export'
    || input.state.kind === 'email_delivery'
    || input.state.kind === 'model_download'
    ? input.opStaleMs
    : null;
}

export async function recoverOrphanedOperations(
  input: RecoverOrphanedOperationsInput,
): Promise<Array<Pick<StreamedOperationState, 'opId' | 'kind' | 'status'>>> {
  const nowMs = input.nowMs ?? Date.now();
  const identity = input.identity ?? WORKER_RUNNER_IDENTITY;
  const states = await input.operationStateStore.listOpStates();
  const candidateStates = states.filter((state) => (
    getOrphanRecoveryThresholdMs({ state, opStaleMs: input.opStaleMs }) !== null
  ));
  const recoveredStates: Array<Pick<StreamedOperationState, 'opId' | 'kind' | 'status'>> = [];

  for (const candidate of candidateStates) {
    const record = await input.operationStateStore.getOpStateRecord(candidate.opId);
    if (!record) continue;
    const staleAfterMs = getOrphanRecoveryThresholdMs({
      state: record.state,
      opStaleMs: input.opStaleMs,
    });
    if (staleAfterMs === null) continue;
    if (!isAbandoned({ state: record.state, nowMs, staleAfterMs, identity })) continue;

    const recovered = await input.orchestrator.markFailedIfUnchanged({
      current: record.state,
      expectedRevision: record.revision,
      error: {
        code: ORPHANED_OPERATION_ERROR_CODE,
        message: 'Worker stopped before completion; operation recovered during reconciliation',
      },
      updatedAt: nowMs,
    });
    if (!recovered) continue;

    recoveredStates.push({
      opId: recovered.opId,
      kind: recovered.kind,
      status: record.state.status,
    });
  }

  return recoveredStates;
}

/**
 * Recover one abandoned operation at the moment a caller reads it.
 *
 * The periodic sweep runs once per control-plane generation, so a worker that
 * restarts while a job is in flight can sweep before that job's state has gone
 * stale and then never look again. Resolving an operation is the point where it
 * matters whether it is still alive, so the read settles it: an in-flight
 * operation whose state has gone stale becomes a failure the caller can report
 * and retry, instead of a running operation nothing is working on.
 */
export async function recoverStaleOperation(input: {
  operationStateStore: Pick<OrphanRecoveryStateStore, 'getOpStateRecord'>;
  orchestrator: OrphanRecoveryOrchestrator;
  state: StreamedOperationState;
  opStaleMs: number;
  nowMs?: number;
  identity?: RunnerIdentity;
}): Promise<StreamedOperationState> {
  const nowMs = input.nowMs ?? Date.now();
  const identity = input.identity ?? WORKER_RUNNER_IDENTITY;
  const staleAfterMs = getOrphanRecoveryThresholdMs({
    state: input.state,
    opStaleMs: input.opStaleMs,
  });
  if (staleAfterMs === null) return input.state;
  if (!isAbandoned({ state: input.state, nowMs, staleAfterMs, identity })) return input.state;
  const record = await input.operationStateStore.getOpStateRecord(input.state.opId);
  if (!record) return input.state;
  if (!isAbandoned({ state: record.state, nowMs, staleAfterMs, identity })) return record.state;
  const recovered = await input.orchestrator.markFailedIfUnchanged({
    current: record.state,
    expectedRevision: record.revision,
    error: {
      code: ORPHANED_OPERATION_ERROR_CODE,
      message: 'Worker stopped before completion; operation recovered when a reader asked for it',
    },
    updatedAt: nowMs,
  });
  return recovered ?? record.state;
}

import type {
  PdfLayoutJobResult,
  DocumentPreviewJobResult,
  TtsPlaybackExportArtifactResult,
  TtsPlaybackPlanJobResult,
  TtsPlaybackJobResult,
  WorkerJobTiming,
  WorkerJobState,
  WorkerOperationState,
} from '../operations/contracts';

export type StreamedOperationState = WorkerOperationState<
  PdfLayoutJobResult | TtsPlaybackJobResult | TtsPlaybackPlanJobResult | TtsPlaybackExportArtifactResult | DocumentPreviewJobResult
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
  whisperTimeoutMs: number;
  pdfTimeoutMs: number;
  opStaleMs: number;
  nowMs?: number;
}

function isInflightStatus(status: WorkerJobState): boolean {
  return status === 'queued' || status === 'running';
}

export function getOrphanRecoveryThresholdMs(input: {
  state: StreamedOperationState;
  whisperTimeoutMs: number;
  pdfTimeoutMs: number;
  opStaleMs: number;
}): number | null {
  if (!isInflightStatus(input.state.status)) return null;
  if (input.state.status === 'running') {
    return input.state.kind === 'pdf_layout' || input.state.kind === 'tts_playback_export' || input.state.kind === 'document_preview'
      ? input.pdfTimeoutMs
      : input.whisperTimeoutMs;
  }
  return input.state.kind === 'pdf_layout' || input.state.kind === 'document_preview' ? input.opStaleMs : null;
}

export async function recoverOrphanedOperations(
  input: RecoverOrphanedOperationsInput,
): Promise<Array<Pick<StreamedOperationState, 'opId' | 'kind' | 'status'>>> {
  const nowMs = input.nowMs ?? Date.now();
  const states = await input.operationStateStore.listOpStates();
  const candidateStates = states.filter((state) => (
    getOrphanRecoveryThresholdMs({
      state,
      whisperTimeoutMs: input.whisperTimeoutMs,
      pdfTimeoutMs: input.pdfTimeoutMs,
      opStaleMs: input.opStaleMs,
    }) !== null
  ));
  const recoveredStates: Array<Pick<StreamedOperationState, 'opId' | 'kind' | 'status'>> = [];

  for (const candidate of candidateStates) {
    const record = await input.operationStateStore.getOpStateRecord(candidate.opId);
    if (!record) continue;
    const staleAfterMs = getOrphanRecoveryThresholdMs({
      state: record.state,
      whisperTimeoutMs: input.whisperTimeoutMs,
      pdfTimeoutMs: input.pdfTimeoutMs,
      opStaleMs: input.opStaleMs,
    });
    if (staleAfterMs === null) continue;
    const ageMs = nowMs - record.state.updatedAt;
    if (ageMs <= staleAfterMs) continue;

    const recovered = await input.orchestrator.markFailedIfUnchanged({
      current: record.state,
      expectedRevision: record.revision,
      error: {
        code: 'WORKER_ORPHANED_OP',
        message: `Worker stopped before completion; stale operation recovered during reconciliation after ${staleAfterMs}ms`,
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

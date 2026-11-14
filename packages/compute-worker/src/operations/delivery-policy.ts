import type { WorkerOperationKind } from './contracts';

export const WORKER_HEARTBEAT_MS = 5_000;
export const WORKER_ACK_WAIT_MS = 30_000;

export function operationDeliveryLimits(pdfAttempts: number): Record<WorkerOperationKind, number> {
  return {
    pdf_layout: pdfAttempts,
    tts_playback: 1,
    tts_playback_plan: 3,
    tts_playback_export: 3,
    document_preview: 3,
    document_conversion: 3,
    account_export: 3,
    email_delivery: 3,
    model_download: 1,
    maintenance: 3,
  };
}

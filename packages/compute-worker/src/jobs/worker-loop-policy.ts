import type { WorkerOperationKind } from '../operations/contracts';

export type RetryAction = 'nak_retry' | 'term_fail';

export function buildQueueWaitTiming(queuedAt: number, now: number): { queueWaitMs: number } | undefined {
  if (!Number.isFinite(queuedAt) || !Number.isFinite(now)) return undefined;
  return { queueWaitMs: Math.max(0, Math.floor(now - queuedAt)) };
}

export function decideRetryAction(input: {
  kind: WorkerOperationKind;
  deliveryCount: number;
  pdfAttempts: number;
  documentJobAttempts?: number;
  retryable?: boolean;
}): RetryAction {
  if (input.retryable === false) return 'term_fail';
  const attempts = input.kind === 'email_delivery' || input.kind === 'maintenance' ? 3
    : input.kind === 'pdf_layout' ? input.pdfAttempts
      : input.kind === 'document_preview' || input.kind === 'document_conversion' ? input.documentJobAttempts ?? 1 : 1;
  return input.deliveryCount < attempts ? 'nak_retry' : 'term_fail';
}

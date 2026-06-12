import type { WorkerOperationKind } from './compute/api-contracts';

export type RetryAction = 'nak_retry' | 'term_fail';

export function buildQueueWaitTiming(queuedAt: number, now: number): { queueWaitMs: number } | undefined {
  if (!Number.isFinite(queuedAt) || !Number.isFinite(now)) return undefined;
  return { queueWaitMs: Math.max(0, Math.floor(now - queuedAt)) };
}

export function decideRetryAction(input: {
  kind: WorkerOperationKind;
  deliveryCount: number;
  pdfAttempts: number;
  whisperMaxDeliver?: number;
}): RetryAction {
  const whisperMaxDeliver = input.whisperMaxDeliver ?? 1;
  if (input.kind === 'whisper_align') {
    return input.deliveryCount < whisperMaxDeliver ? 'nak_retry' : 'term_fail';
  }

  return input.deliveryCount < input.pdfAttempts ? 'nak_retry' : 'term_fail';
}

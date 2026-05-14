export const SEGMENT_STATUS_RETRY_INITIAL_DELAY_MS = 400;
export const SEGMENT_STATUS_RETRY_MAX_DELAY_MS = 5000;

export function isRetryableSegmentStatus(status: string | null | undefined): boolean {
  return status === 'pending' || status === 'error';
}

export function resolveSegmentStatusRetryDelayMs(input: {
  attempt: number;
  retryAfterSeconds?: number | null;
  initialDelayMs?: number;
  maxDelayMs?: number;
}): number {
  const initialDelayMs = input.initialDelayMs ?? SEGMENT_STATUS_RETRY_INITIAL_DELAY_MS;
  const maxDelayMs = input.maxDelayMs ?? SEGMENT_STATUS_RETRY_MAX_DELAY_MS;
  const retryAfterSeconds = input.retryAfterSeconds;

  if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    const hintedDelayMs = Math.ceil(retryAfterSeconds * 1000);
    return Math.max(initialDelayMs, Math.min(hintedDelayMs, maxDelayMs));
  }

  const computedDelayMs = Math.min(
    initialDelayMs * Math.pow(2, Math.max(0, input.attempt)),
    maxDelayMs,
  );
  return Math.max(initialDelayMs, computedDelayMs);
}

export function shouldDeferSegmentRetry(nowMs: number, retryAtMs: number | undefined): boolean {
  return typeof retryAtMs === 'number' && Number.isFinite(retryAtMs) && retryAtMs > nowMs;
}

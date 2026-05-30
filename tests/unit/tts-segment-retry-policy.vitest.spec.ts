import { describe, expect, test } from 'vitest';

import {
  isRetryableSegmentStatus,
  resolveSegmentStatusRetryDelayMs,
  shouldDeferSegmentRetry,
} from '../../src/lib/client/tts/segment-retry-policy';

describe('tts segment retry policy', () => {
  test('marks pending/error statuses as retryable', () => {
    expect(isRetryableSegmentStatus('pending')).toBe(true);
    expect(isRetryableSegmentStatus('error')).toBe(true);
    expect(isRetryableSegmentStatus('completed')).toBe(false);
    expect(isRetryableSegmentStatus('missing')).toBe(false);
    expect(isRetryableSegmentStatus(null)).toBe(false);
  });

  test('uses exponential backoff when retry-after hint is missing', () => {
    expect(resolveSegmentStatusRetryDelayMs({ attempt: 0 })).toBe(400);
    expect(resolveSegmentStatusRetryDelayMs({ attempt: 1 })).toBe(800);
    expect(resolveSegmentStatusRetryDelayMs({ attempt: 2 })).toBe(1600);
  });

  test('caps delay by max delay', () => {
    expect(resolveSegmentStatusRetryDelayMs({ attempt: 10 })).toBe(5000);
  });

  test('honors retry-after hint when present', () => {
    expect(resolveSegmentStatusRetryDelayMs({ attempt: 0, retryAfterSeconds: 2 })).toBe(2000);
    expect(resolveSegmentStatusRetryDelayMs({ attempt: 0, retryAfterSeconds: 0.1 })).toBe(400);
    expect(resolveSegmentStatusRetryDelayMs({ attempt: 0, retryAfterSeconds: 99 })).toBe(5000);
  });

  test('defers retries while cooldown is active', () => {
    expect(shouldDeferSegmentRetry(1000, 1001)).toBe(true);
    expect(shouldDeferSegmentRetry(1000, 999)).toBe(false);
    expect(shouldDeferSegmentRetry(1000, undefined)).toBe(false);
  });
});

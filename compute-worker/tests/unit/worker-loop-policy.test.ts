import { describe, expect, test } from 'vitest';
import { buildQueueWaitTiming, decideRetryAction } from '../../src/worker-loop-policy';

describe('worker loop policy', () => {
  test('returns queue wait timing with non-negative clamped duration', () => {
    expect(buildQueueWaitTiming(1000, 1300)).toEqual({ queueWaitMs: 300 });
    expect(buildQueueWaitTiming(1500, 1300)).toEqual({ queueWaitMs: 0 });
  });

  test('retry policy: layout jobs can retry until max attempts', () => {
    expect(decideRetryAction({ kind: 'pdf_layout', deliveryCount: 1, pdfAttempts: 3 })).toBe('nak_retry');
    expect(decideRetryAction({ kind: 'pdf_layout', deliveryCount: 3, pdfAttempts: 3 })).toBe('term_fail');
  });

  test('retry policy: whisper jobs terminate immediately by default', () => {
    expect(decideRetryAction({ kind: 'whisper_align', deliveryCount: 1, pdfAttempts: 10 })).toBe('term_fail');
  });
});

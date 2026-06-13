import { afterEach, describe, expect, test, vi } from 'vitest';
import { recoverOrphanedOperations } from '../../src/operations/recovery';
import { FakeControlPlane } from '../fixtures/fake-control-plane';

describe('orphan recovery', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('recovers a running whisper op when a later sweep crosses the timeout in the same session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T08:00:00.000Z'));

    const fake = new FakeControlPlane();
    const startedAt = Date.now();
    fake.seedState({
      opId: 'op-whisper-running',
      opKey: 'k-whisper-running',
      kind: 'whisper_align',
      jobId: 'job-op-whisper-running',
      status: 'running',
      queuedAt: startedAt,
      updatedAt: startedAt,
    });

    const firstSweep = await recoverOrphanedOperations({
      operationStateStore: fake.deps.operationStateStore!,
      orchestrator: fake.deps.orchestrator!,
      whisperTimeoutMs: 30_000,
      pdfTimeoutMs: 300_000,
      opStaleMs: 1_800_000,
    });
    expect(firstSweep).toEqual([]);
    expect(fake.getState('op-whisper-running')).toMatchObject({
      status: 'running',
    });

    vi.advanceTimersByTime(31_000);

    const secondSweep = await recoverOrphanedOperations({
      operationStateStore: fake.deps.operationStateStore!,
      orchestrator: fake.deps.orchestrator!,
      whisperTimeoutMs: 30_000,
      pdfTimeoutMs: 300_000,
      opStaleMs: 1_800_000,
    });
    expect(secondSweep).toEqual([{
      opId: 'op-whisper-running',
      kind: 'whisper_align',
      status: 'running',
    }]);
    expect(fake.getState('op-whisper-running')).toMatchObject({
      status: 'failed',
      error: {
        code: 'WORKER_ORPHANED_OP',
      },
    });
  });
});

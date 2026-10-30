import { afterEach, describe, expect, test, vi } from 'vitest';
import { getOrphanRecoveryThresholdMs, recoverOrphanedOperations } from '../../src/operations/recovery';
import { FakeControlPlane } from '../fixtures/fake-control-plane';

describe('orphan recovery', () => {
  test('keeps queued maintenance behind a long sweep but recovers an abandoned running job', async () => {
    const fake = new FakeControlPlane();
    for (const status of ['queued', 'running'] as const) fake.seedState({
      opId: `maintenance-${status}`, opKey: `maintenance|v1|delete-users|${status}`,
      kind: 'maintenance', jobId: `job-${status}`, status, queuedAt: 1, updatedAt: 1,
    });
    const recovered = await recoverOrphanedOperations({
      operationStateStore: fake.deps.operationStateStore, orchestrator: fake.deps.orchestrator,
      whisperTimeoutMs: 30_000, pdfTimeoutMs: 300_000, opStaleMs: 1_800_000, nowMs: 7_200_000,
    });
    expect(recovered).toEqual([{ opId: 'maintenance-running', kind: 'maintenance', status: 'running' }]);
    expect(fake.getState('maintenance-queued')?.status).toBe('queued');
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('gives queued playback-plan operations a terminal stale threshold', () => {
    expect(getOrphanRecoveryThresholdMs({
      state: {
        opId: 'op-plan-queued',
        opKey: 'k-plan-queued',
        kind: 'tts_playback_plan',
        jobId: 'job-op-plan-queued',
        status: 'queued',
        queuedAt: 1,
        updatedAt: 1,
      },
      whisperTimeoutMs: 30_000,
      pdfTimeoutMs: 300_000,
      opStaleMs: 1_800_000,
    })).toBe(1_800_000);
  });

  test('recovers a running playback op when a later sweep crosses the timeout in the same session', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-03T08:00:00.000Z'));

    const fake = new FakeControlPlane();
    const startedAt = Date.now();
    fake.seedState({
      opId: 'op-playback-running',
      opKey: 'k-playback-running',
      kind: 'tts_playback',
      jobId: 'job-op-playback-running',
      status: 'running',
      queuedAt: startedAt,
      updatedAt: startedAt,
    });

    const firstSweep = await recoverOrphanedOperations({
      operationStateStore: fake.deps.operationStateStore,
      orchestrator: fake.deps.orchestrator,
      whisperTimeoutMs: 30_000,
      pdfTimeoutMs: 300_000,
      opStaleMs: 1_800_000,
    });
    expect(firstSweep).toEqual([]);
    expect(fake.getState('op-playback-running')).toMatchObject({
      status: 'running',
    });

    vi.advanceTimersByTime(31_000);

    const secondSweep = await recoverOrphanedOperations({
      operationStateStore: fake.deps.operationStateStore,
      orchestrator: fake.deps.orchestrator,
      whisperTimeoutMs: 30_000,
      pdfTimeoutMs: 300_000,
      opStaleMs: 1_800_000,
    });
    expect(secondSweep).toEqual([{
      opId: 'op-playback-running',
      kind: 'tts_playback',
      status: 'running',
    }]);
    expect(fake.getState('op-playback-running')).toMatchObject({
      status: 'failed',
      error: {
        code: 'WORKER_ORPHANED_OP',
      },
    });
  });
});

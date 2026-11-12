import { afterEach, describe, expect, test, vi } from 'vitest';
import { RUNNING_OPERATION_STALE_MS } from '../../src/operations/contracts';
import {
  getOrphanRecoveryThresholdMs,
  recoverOrphanedOperations,
  recoverStaleOperation,
} from '../../src/operations/recovery';
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
      opStaleMs: 1_800_000, nowMs: 7_200_000,
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
      opStaleMs: 1_800_000,
    })).toBe(1_800_000);
  });

  test('recovers a running playback op once a later sweep crosses its heartbeat window', async () => {
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
      opStaleMs: 1_800_000,
    });
    expect(firstSweep).toEqual([]);
    expect(fake.getState('op-playback-running')).toMatchObject({
      status: 'running',
    });

    vi.advanceTimersByTime(RUNNING_OPERATION_STALE_MS + 1_000);

    const secondSweep = await recoverOrphanedOperations({
      operationStateStore: fake.deps.operationStateStore,
      orchestrator: fake.deps.orchestrator,
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

  test('settles an abandoned running operation when a caller resolves it after the sweep already ran', async () => {
    const fake = new FakeControlPlane();
    fake.seedState({
      opId: 'op-pdf-running',
      opKey: 'k-pdf-running',
      kind: 'pdf_layout',
      jobId: 'job-op-pdf-running',
      status: 'running',
      queuedAt: 1_000,
      updatedAt: 1_000,
    });
    const resolve = (nowMs: number) => recoverStaleOperation({
      operationStateStore: fake.deps.operationStateStore,
      orchestrator: fake.deps.orchestrator,
      state: fake.getState('op-pdf-running')!,
      opStaleMs: 1_800_000,
      nowMs,
    });

    await expect(resolve(1_000 + RUNNING_OPERATION_STALE_MS)).resolves.toMatchObject({ status: 'running' });
    await expect(resolve(1_000 + RUNNING_OPERATION_STALE_MS + 1)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'WORKER_ORPHANED_OP' },
    });
    expect(fake.getState('op-pdf-running')?.status).toBe('failed');
  });
});

describe('operations a restarted worker left behind', () => {
  const runningState = (runner?: { workerId: string; incarnationId: string }) => ({
    opId: 'op-pdf-interrupted',
    opKey: 'k-pdf-interrupted',
    kind: 'pdf_layout' as const,
    jobId: 'job-op-pdf-interrupted',
    status: 'running' as const,
    queuedAt: 1_000,
    updatedAt: 10_000,
    ...(runner ? { runner } : {}),
  });

  test('settles its predecessor’s running operation at once, without waiting out a heartbeat', async () => {
    const fake = new FakeControlPlane();
    fake.seedState(runningState({ workerId: 'this-host', incarnationId: 'before-the-restart' }));
    const identity = { workerId: 'this-host', incarnationId: 'after-the-restart', startedAtMs: 11_000 };

    // One millisecond after the restart: far inside the heartbeat window that
    // used to leave a reader watching a parse nothing was working on.
    await expect(recoverStaleOperation({
      operationStateStore: fake.deps.operationStateStore,
      orchestrator: fake.deps.orchestrator,
      state: fake.getState('op-pdf-interrupted')!,
      opStaleMs: 1_800_000,
      nowMs: 11_001,
      identity,
    })).resolves.toMatchObject({ status: 'failed', error: { code: 'WORKER_ORPHANED_OP' } });
  });

  test('leaves a sibling worker’s operation alone, and its own live one', async () => {
    const identity = { workerId: 'this-host', incarnationId: 'mine', startedAtMs: 11_000 };
    for (const runner of [
      { workerId: 'another-host', incarnationId: 'theirs' },
      { workerId: 'this-host', incarnationId: 'mine' },
      undefined,
    ]) {
      const fake = new FakeControlPlane();
      fake.seedState(runningState(runner));

      await expect(recoverStaleOperation({
        operationStateStore: fake.deps.operationStateStore,
        orchestrator: fake.deps.orchestrator,
        state: fake.getState('op-pdf-interrupted')!,
        opStaleMs: 1_800_000,
        nowMs: 11_001,
        identity,
      })).resolves.toMatchObject({ status: 'running' });
    }
  });

  test('leaves an operation a restarted worker is already reporting again', async () => {
    const fake = new FakeControlPlane();
    // Written after this process started, so some worker is alive and on it.
    fake.seedState({ ...runningState({ workerId: 'this-host', incarnationId: 'older' }), updatedAt: 12_000 });

    await expect(recoverStaleOperation({
      operationStateStore: fake.deps.operationStateStore,
      orchestrator: fake.deps.orchestrator,
      state: fake.getState('op-pdf-interrupted')!,
      opStaleMs: 1_800_000,
      nowMs: 12_001,
      identity: { workerId: 'this-host', incarnationId: 'mine', startedAtMs: 11_000 },
    })).resolves.toMatchObject({ status: 'running' });
  });
});

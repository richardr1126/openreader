import { describe, expect, test } from 'vitest';
import { RUNNING_OPERATION_STALE_MS } from '../../../src/operations/contracts';
import type { WorkerOperationState } from '../../../src/operations/contracts';
import {
  explainReplacementReason,
  isInflightStatus,
  isTerminalStatus,
  shouldReuseExistingOperation,
} from '../../../src/operations/state-machine';

function runningState(overrides: Partial<WorkerOperationState> = {}): WorkerOperationState {
  return {
    opId: 'op-1',
    opKey: 'key-1',
    kind: 'pdf_layout',
    jobId: 'job-1',
    status: 'running',
    queuedAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

describe('state-machine decisions', () => {
  test('reuses a queued maintenance operation after the ordinary stale threshold', () => {
    expect(shouldReuseExistingOperation({
      current: runningState({ kind: 'maintenance', status: 'queued' }), requestKind: 'maintenance',
      now: 7_200_000, opStaleMs: 1_800_000,
    })).toBe(true);
    expect(shouldReuseExistingOperation({
      current: runningState({ kind: 'maintenance', status: 'running' }), requestKind: 'maintenance',
      now: 7_200_000, opStaleMs: 1_800_000,
    })).toBe(false);
  });
  test('identifies terminal and inflight states', () => {
    expect(isTerminalStatus('succeeded')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('queued')).toBe(false);

    expect(isInflightStatus('queued')).toBe(true);
    expect(isInflightStatus('running')).toBe(true);
    expect(isInflightStatus('failed')).toBe(false);
  });

  test('judges a running operation on its heartbeat, not on the queue stale window', () => {
    const current = runningState();
    const decide = (now: number) => shouldReuseExistingOperation({
      current,
      requestKind: 'pdf_layout',
      now,
      opStaleMs: 1_800_000,
    });

    // A heartbeating job keeps its operation however long the work takes.
    expect(decide(current.updatedAt + RUNNING_OPERATION_STALE_MS)).toBe(true);
    // Silence past that window means no worker is executing it, whatever the
    // much longer queue window would allow.
    expect(decide(current.updatedAt + RUNNING_OPERATION_STALE_MS + 1)).toBe(false);

    expect(explainReplacementReason({
      current,
      requestKind: 'pdf_layout',
      now: current.updatedAt + RUNNING_OPERATION_STALE_MS + 1,
      opStaleMs: 1_800_000,
    })).toBe('stale_running');
  });

  test('keeps a queued operation for the whole queue stale window', () => {
    const current = runningState({ status: 'queued' });

    expect(shouldReuseExistingOperation({
      current,
      requestKind: 'pdf_layout',
      now: current.updatedAt + RUNNING_OPERATION_STALE_MS + 1,
      opStaleMs: 1_800_000,
    })).toBe(true);

    expect(shouldReuseExistingOperation({
      current,
      requestKind: 'pdf_layout',
      now: current.updatedAt + 1_800_001,
      opStaleMs: 1_800_000,
    })).toBe(false);
  });

  test('never reuses kind-mismatched operation', () => {
    const current = runningState({ kind: 'tts_playback' });

    expect(shouldReuseExistingOperation({
      current,
      requestKind: 'pdf_layout',
      now: 2_100,
      opStaleMs: 10_000,
    })).toBe(false);

    expect(explainReplacementReason({
      current,
      requestKind: 'pdf_layout',
      now: 2_100,
      opStaleMs: 10_000,
    })).toBe('kind_mismatch');
  });

  test('reuses terminal playback plan operations', () => {
    const current = runningState({
      kind: 'tts_playback_plan',
      status: 'succeeded',
    });

    expect(shouldReuseExistingOperation({
      current,
      requestKind: 'tts_playback_plan',
      now: 2_100,
      opStaleMs: 10_000,
    })).toBe(true);
  });
});

import { describe, expect, test } from 'vitest';
import type { WorkerOperationState } from '../../../src/api/contracts';
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
  test('identifies terminal and inflight states', () => {
    expect(isTerminalStatus('succeeded')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('queued')).toBe(false);

    expect(isInflightStatus('queued')).toBe(true);
    expect(isInflightStatus('running')).toBe(true);
    expect(isInflightStatus('failed')).toBe(false);
  });

  test('reuses fresh inflight operation and rejects stale inflight operation', () => {
    const current = runningState();

    expect(shouldReuseExistingOperation({
      current,
      requestKind: 'pdf_layout',
      now: 2_900,
      opStaleMs: 1_000,
    })).toBe(true);

    expect(shouldReuseExistingOperation({
      current,
      requestKind: 'pdf_layout',
      now: 3_100,
      opStaleMs: 1_000,
    })).toBe(false);

    expect(explainReplacementReason({
      current,
      requestKind: 'pdf_layout',
      now: 3_100,
      opStaleMs: 1_000,
    })).toBe('stale_running');
  });

  test('never reuses kind-mismatched operation', () => {
    const current = runningState({ kind: 'whisper_align' });

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
});

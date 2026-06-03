import { describe, expect, test } from 'vitest';
import type { PdfLayoutJobResult, WorkerOperationState } from '@openreader/compute-core/api-contracts';
import {
  documentParseStateFromWorkerState,
  isWorkerOperationStateStale,
  snapshotFromWorkerState,
} from '../../src/lib/server/compute/worker-parse-state';

function makeWorkerState(
  overrides: Partial<WorkerOperationState<PdfLayoutJobResult>>,
): WorkerOperationState<PdfLayoutJobResult> {
  return {
    opId: 'op-123',
    opKey: 'pdf_layout|v1|doc-1',
    kind: 'pdf_layout',
    jobId: 'job-123',
    status: 'queued',
    queuedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('worker parse state mapping', () => {
  test('maps queued worker state to pending parse state with op identifiers', () => {
    const workerState = makeWorkerState({
      status: 'queued',
      progress: {
        totalPages: 500,
        pagesParsed: 0,
        currentPage: 1,
        phase: 'infer',
      },
    });

    expect(snapshotFromWorkerState(workerState)).toEqual({
      parseStatus: 'pending',
      parseProgress: null,
    });
    expect(documentParseStateFromWorkerState(workerState, 1234)).toEqual({
      status: 'pending',
      progress: null,
      updatedAt: 1234,
      opId: 'op-123',
      jobId: 'job-123',
    });
  });

  test('maps running worker state to running parse state with progress', () => {
    const workerState = makeWorkerState({
      status: 'running',
      progress: {
        totalPages: 500,
        pagesParsed: 120,
        currentPage: 121,
        phase: 'infer',
      },
    });

    expect(documentParseStateFromWorkerState(workerState, 5678)).toEqual({
      status: 'running',
      progress: {
        totalPages: 500,
        pagesParsed: 120,
        currentPage: 121,
        phase: 'infer',
      },
      updatedAt: 5678,
      opId: 'op-123',
      jobId: 'job-123',
    });
  });

  test('maps failed worker state to failed parse state and preserves the worker error', () => {
    const workerState = makeWorkerState({
      status: 'failed',
      error: {
        code: 'PDF_PARSE_FAILED',
        message: 'layout model crashed',
      },
    });

    expect(documentParseStateFromWorkerState(workerState, 9999)).toEqual({
      status: 'failed',
      progress: null,
      updatedAt: 9999,
      opId: 'op-123',
      jobId: 'job-123',
      error: 'layout model crashed',
    });
  });

  test('treats old inflight worker states as stale', () => {
    const workerState = makeWorkerState({
      status: 'running',
      updatedAt: 1_000,
      progress: {
        totalPages: 500,
        pagesParsed: 250,
        currentPage: 251,
        phase: 'infer',
      },
    });

    expect(isWorkerOperationStateStale(workerState, 5_000, 6_001)).toBe(true);
    expect(isWorkerOperationStateStale(workerState, 5_000, 5_999)).toBe(false);
  });

  test('never treats terminal worker states as stale', () => {
    const failedState = makeWorkerState({
      status: 'failed',
      updatedAt: 1_000,
      error: { code: 'PDF_PARSE_FAILED', message: 'crashed' },
    });

    expect(isWorkerOperationStateStale(failedState, 5_000, 99_999)).toBe(false);
  });
});

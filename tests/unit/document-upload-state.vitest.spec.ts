import { describe, expect, test } from 'vitest';

import {
  deriveDocumentUploadSummary,
  documentUploadReducer,
  type DocumentUploadState,
} from '@/lib/client/uploads/state';

const initialState: DocumentUploadState = {
  batches: [{
    id: 'batch-1',
    folderId: 'folder-1',
    startedAt: 1,
    tasks: [
      {
        id: 'batch-1:0',
        name: 'notes.md',
        size: 100,
        phase: 'queued',
        transferredBytes: 0,
        workerPhase: null,
        error: null,
      },
      {
        id: 'batch-1:1',
        name: 'report.docx',
        size: 300,
        phase: 'queued',
        transferredBytes: 0,
        workerPhase: null,
        error: null,
      },
    ],
  }],
};

describe('document upload lifecycle state', () => {
  test('combines byte transfer with worker conversion phases', () => {
    let state = documentUploadReducer(initialState, {
      type: 'progress',
      batchId: 'batch-1',
      event: { phase: 'transferring', sourceIndex: 0, loadedBytes: 50, totalBytes: 100 },
    });
    state = documentUploadReducer(state, {
      type: 'progress',
      batchId: 'batch-1',
      event: { phase: 'source-complete', sourceIndex: 0 },
    });
    state = documentUploadReducer(state, {
      type: 'progress',
      batchId: 'batch-1',
      event: {
        phase: 'processing',
        sourceIndex: 1,
        operationStatus: 'running',
        workerPhase: 'converting',
      },
    });

    expect(state.batches[0]?.tasks.map((task) => task.phase)).toEqual(['complete', 'processing']);
    expect(deriveDocumentUploadSummary(state)).toEqual(expect.objectContaining({
      isActive: true,
      completedFiles: 1,
      totalFiles: 2,
      transferredBytes: 400,
      currentFileName: 'report.docx',
      detail: 'Converting Word document',
    }));
  });

  test('retains failed batches for retry and removes terminal status on dismiss', () => {
    const failed = documentUploadReducer(initialState, {
      type: 'failed',
      batchId: 'batch-1',
      error: 'Storage unavailable',
    });

    const failedSummary = deriveDocumentUploadSummary(failed);
    expect(failedSummary).toEqual(expect.objectContaining({
      isActive: false,
      hasFailures: true,
      error: 'Storage unavailable',
    }));
    expect(failedSummary?.progress).toBeLessThan(100);

    const retried = documentUploadReducer(failed, {
      type: 'retry',
      batchId: 'batch-1',
      startedAt: 2,
    });
    expect(retried.batches[0]?.tasks.every((task) => task.phase === 'queued')).toBe(true);
    expect(documentUploadReducer(failed, { type: 'remove-terminal' })).toEqual({ batches: [] });
  });
});

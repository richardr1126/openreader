import { describe, expect, test } from 'vitest';

import { resolvePdfOperationReadiness } from '@/lib/server/reader/bootstrap-progress';
import { pdfParseSnapshotFromWorkerState } from '@/lib/server/pdf-parse/snapshot';
import type { ComputeOperation, PdfLayoutResult } from '@/lib/server/compute-worker/protocol';

describe('reader model download progress', () => {
  test('keeps worker model progress in the PDF snapshot', () => {
    const state = {
      opId: 'pdf-op',
      status: 'running',
      progress: {
        phase: 'download_model',
        totalPages: 0,
        pagesParsed: 0,
        downloadedBytes: 75,
        totalBytes: 100,
      },
    } as ComputeOperation<PdfLayoutResult>;

    expect(pdfParseSnapshotFromWorkerState(state).parseProgress).toMatchObject({
      phase: 'download_model',
      downloadedBytes: 75,
      totalBytes: 100,
    });
  });

  test('offers a retry for a PDF operation abandoned by a stopped worker, without its diagnostics', () => {
    const abandoned = resolvePdfOperationReadiness({
      opId: 'pdf-op',
      status: 'failed',
      error: {
        code: 'WORKER_ORPHANED_OP',
        message: 'Worker stopped before completion; stale operation recovered on read after 60000ms',
      },
    } as ComputeOperation<PdfLayoutResult>);

    expect(abandoned?.result).toMatchObject({
      status: 'error',
      retryable: true,
      failedPdfOperationId: 'pdf-op',
    });
    expect(abandoned?.result.status === 'error' && abandoned.result.message)
      .toBe('PDF preparation stopped before it finished, because the app or its compute worker restarted.');
  });

  test('keeps a genuine parse failure message', () => {
    const failed = resolvePdfOperationReadiness({
      opId: 'pdf-op',
      status: 'failed',
      error: { message: 'No text layer found' },
    } as ComputeOperation<PdfLayoutResult>);

    expect(failed?.result).toMatchObject({
      status: 'error',
      message: 'No text layer found',
      retryable: true,
      failedPdfOperationId: 'pdf-op',
    });
  });
});

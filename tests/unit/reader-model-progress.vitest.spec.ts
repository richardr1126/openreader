import { describe, expect, test } from 'vitest';

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
});

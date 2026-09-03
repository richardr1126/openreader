import { describe, expect, test, vi } from 'vitest';

import {
  createModelDownloadProgressReporter,
  MODEL_DOWNLOAD_PROGRESS_MIN_BYTES,
} from '../../src/jobs/model-download-progress';
import type { ModelDownloadProgress } from '../../src/inference/model-download';

describe('model download progress reporting', () => {
  test('publishes bounded checkpoints without hiding the first or terminal state', async () => {
    let now = 10_000;
    const publish = vi.fn(async (progress: ModelDownloadProgress) => {
      void progress;
    });
    const onObserved = vi.fn();
    const report = createModelDownloadProgressReporter({
      publish,
      onObserved,
      now: () => now,
    });
    const totalBytes = MODEL_DOWNLOAD_PROGRESS_MIN_BYTES * 4;

    await report({ downloadedBytes: 0, totalBytes });
    await report({ downloadedBytes: 1024, totalBytes });
    await report({ downloadedBytes: MODEL_DOWNLOAD_PROGRESS_MIN_BYTES, totalBytes });
    now += 1_000;
    await report({ downloadedBytes: MODEL_DOWNLOAD_PROGRESS_MIN_BYTES + 1024, totalBytes });
    await report({ downloadedBytes: totalBytes, totalBytes });

    expect(onObserved).toHaveBeenCalledTimes(5);
    expect(publish.mock.calls.map(([progress]) => progress.downloadedBytes)).toEqual([
      0,
      MODEL_DOWNLOAD_PROGRESS_MIN_BYTES,
      MODEL_DOWNLOAD_PROGRESS_MIN_BYTES + 1024,
      totalBytes,
    ]);
  });

  test('does not treat every chunk as terminal when total size is unknown', async () => {
    const publish = vi.fn(async (progress: ModelDownloadProgress) => {
      void progress;
    });
    const report = createModelDownloadProgressReporter({ publish, now: () => 10_000 });

    await report({ downloadedBytes: 0, totalBytes: 0 });
    await report({ downloadedBytes: 1024, totalBytes: 0 });
    await report({ downloadedBytes: MODEL_DOWNLOAD_PROGRESS_MIN_BYTES, totalBytes: 0 });

    expect(publish).toHaveBeenCalledTimes(2);
  });
});

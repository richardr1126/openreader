import type {
  ModelDownloadProgress,
  ModelDownloadProgressHandler,
} from '../inference/model-download';

export const MODEL_DOWNLOAD_PROGRESS_MIN_BYTES = 8 * 1024 * 1024;
export const MODEL_DOWNLOAD_PROGRESS_MAX_INTERVAL_MS = 1_000;

/**
 * Keep model-download telemetry useful without putting durable operation-state
 * writes in the hot path for every network chunk. The first, terminal, byte,
 * and time checkpoints are still delivered in order.
 */
export function createModelDownloadProgressReporter(input: {
  publish: ModelDownloadProgressHandler;
  onObserved?: () => void;
  now?: () => number;
}): ModelDownloadProgressHandler {
  let lastPublishedAt = 0;
  let lastPublishedBytes = -1;
  const now = input.now ?? Date.now;

  return async (progress: ModelDownloadProgress) => {
    input.onObserved?.();
    const observedAt = now();
    const shouldPublish = lastPublishedBytes < 0
      || (progress.totalBytes > 0 && progress.downloadedBytes >= progress.totalBytes)
      || progress.downloadedBytes - lastPublishedBytes >= MODEL_DOWNLOAD_PROGRESS_MIN_BYTES
      || observedAt - lastPublishedAt >= MODEL_DOWNLOAD_PROGRESS_MAX_INTERVAL_MS;
    if (!shouldPublish) return;

    lastPublishedAt = observedAt;
    lastPublishedBytes = progress.downloadedBytes;
    await input.publish(progress);
  };
}

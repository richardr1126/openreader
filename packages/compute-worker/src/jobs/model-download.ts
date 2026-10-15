import { ensureKokoroAssets } from '../inference/kokoro/model-files';
import type { ModelDownloadProgress } from '../inference/model-download';
import type { ModelDownloadJobRequest, ModelDownloadJobResult } from '../operations/contracts';
import { createModelDownloadProgressReporter } from './model-download-progress';

/**
 * Downloads a model ahead of first use, for the Local voices card. It joins the
 * download playback would start, so the two never fetch the same files twice.
 * A cancel fails it with the reason `cancelKokoroDownload` gives.
 */
export async function runModelDownload(
  payload: ModelDownloadJobRequest,
  _queueWaitMs: number,
  hooks?: { onProgress?: (progress: ModelDownloadProgress) => Promise<void> },
): Promise<ModelDownloadJobResult> {
  await ensureKokoroAssets(createModelDownloadProgressReporter({
    publish: async (progress) => { await hooks?.onProgress?.(progress); },
  }));
  return { model: payload.model };
}

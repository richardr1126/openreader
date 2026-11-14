import { ensureKokoroAssets } from '../inference/kokoro/model-files';
import type { ModelDownloadProgress } from '../inference/model-download';
import type { ModelDownloadJobRequest, ModelDownloadJobResult } from '../operations/contracts';
import type { JobExecution } from '../operations/types';
import { createModelDownloadProgressReporter } from './model-download-progress';

/**
 * Downloads a model ahead of first use, for the Local voices card. It joins the
 * download playback would start, so the two never fetch the same files twice.
 * A cancel fails it with the reason `cancelKokoroDownload` gives.
 */
export async function runModelDownload(
  payload: ModelDownloadJobRequest,
  _queueWaitMs: number,
  hooks?: Partial<JobExecution<ModelDownloadProgress>>,
): Promise<ModelDownloadJobResult> {
  await hooks?.assertActive?.();
  await ensureKokoroAssets(createModelDownloadProgressReporter({
    publish: async (progress) => {
      // This observer can lose its delivery while playback is still waiting
      // on the same download. Keep operation-state errors local to the job.
      await hooks?.onProgress?.(progress).catch(() => undefined);
    },
  }), undefined, hooks?.signal);
  await hooks?.assertActive?.();
  return { model: payload.model };
}

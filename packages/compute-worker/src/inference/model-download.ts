import { open, writeFile } from 'node:fs/promises';

export type ModelComponentState = 'pending' | 'downloading' | 'verifying' | 'ready' | 'failed';

/** One named part of a multi-file model, such as a voice's weights or data. */
export type ModelComponentProgress = {
  name: string;
  totalBytes: number;
  downloadedBytes: number;
  state: ModelComponentState;
};

export type ModelDownloadProgress = {
  downloadedBytes: number;
  totalBytes: number;
  components?: ModelComponentProgress[];
};

export type ModelDownloadProgressHandler = (
  progress: ModelDownloadProgress,
) => void | Promise<void>;

export type ModelFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function downloadModelArtifact(input: {
  url: string;
  outPath: string;
  expectedBytes?: number;
  fetchImpl?: ModelFetch;
  onProgress?: ModelDownloadProgressHandler;
}): Promise<number> {
  const response = await (input.fetchImpl ?? fetch)(input.url);
  if (!response.ok) {
    throw new Error(`Download failed for ${input.url}: ${response.status} ${response.statusText}`);
  }

  const responseBytes = Number(response.headers.get('content-length') ?? 0);
  const totalBytes = Math.max(0, Number(input.expectedBytes ?? 0)) || responseBytes;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    await input.onProgress?.({ downloadedBytes: bytes.byteLength, totalBytes: totalBytes || bytes.byteLength });
    await writeFile(input.outPath, bytes);
    return bytes.byteLength;
  }

  // Written as it arrives: a model can be hundreds of megabytes, and holding
  // it in memory before writing would double the worker's peak.
  const reader = response.body.getReader();
  const file = await open(input.outPath, 'w');
  let downloadedBytes = 0;
  try {
    await input.onProgress?.({ downloadedBytes, totalBytes });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      await file.write(value);
      downloadedBytes += value.byteLength;
      await input.onProgress?.({ downloadedBytes, totalBytes: totalBytes || downloadedBytes });
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    await file.close();
  }
  return downloadedBytes;
}

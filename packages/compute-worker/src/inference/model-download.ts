import { writeFile } from 'node:fs/promises';

export type ModelDownloadProgress = {
  downloadedBytes: number;
  totalBytes: number;
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

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let downloadedBytes = 0;
  await input.onProgress?.({ downloadedBytes, totalBytes });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    chunks.push(value);
    downloadedBytes += value.byteLength;
    await input.onProgress?.({ downloadedBytes, totalBytes: totalBytes || downloadedBytes });
  }
  await writeFile(input.outPath, Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
  return downloadedBytes;
}

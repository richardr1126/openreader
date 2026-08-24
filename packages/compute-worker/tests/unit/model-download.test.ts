import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { downloadModelArtifact } from '../../src/inference/model-download';

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('model artifact downloads', () => {
  test('streams byte progress while preserving the downloaded artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openreader-model-download-'));
    cleanupDirs.push(dir);
    const outPath = join(dir, 'model.bin');
    const progress: Array<{ downloadedBytes: number; totalBytes: number }> = [];
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3, 4, 5]));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-length': '5' },
    }));

    await expect(downloadModelArtifact({
      url: 'https://models.example/model.bin',
      outPath,
      expectedBytes: 5,
      fetchImpl,
      onProgress: (snapshot) => { progress.push(snapshot); },
    })).resolves.toBe(5);

    expect([...await readFile(outPath)]).toEqual([1, 2, 3, 4, 5]);
    expect(progress).toEqual([
      { downloadedBytes: 0, totalBytes: 5 },
      { downloadedBytes: 2, totalBytes: 5 },
      { downloadedBytes: 5, totalBytes: 5 },
    ]);
  });
});

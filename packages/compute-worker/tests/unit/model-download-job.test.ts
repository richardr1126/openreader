import { rmSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { runModelDownload } from '../../src/jobs/model-download';
import { cancelKokoroDownload, isKokoroDownloading } from '../../src/inference/kokoro/model-files';

// An empty docstore, so the job always has something to download.
const docstore = vi.hoisted(() => {
  const { mkdtempSync: mkdtemp } = require('node:fs') as typeof import('node:fs');
  const { tmpdir: tmp } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');
  return mkdtemp(join(tmp(), 'openreader-docstore-'));
});
vi.mock('../../src/infrastructure/platform', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/infrastructure/platform')>(),
  DOCSTORE_DIR: docstore,
}));

describe('model download job', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  afterAll(() => { rmSync(docstore, { recursive: true, force: true }); });

  test('a cancel fails the job with a readable reason and leaves nothing downloading', async () => {
    // Hold the first request open until the cancel aborts it.
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    vi.stubGlobal('fetch', fetchImpl);
    const onProgress = vi.fn(async () => undefined);
    const job = runModelDownload({ model: 'kokoro-82m' }, 0, { onProgress });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    expect(isKokoroDownloading()).toBe(true);

    expect(cancelKokoroDownload()).toBe(true);
    await expect(job).rejects.toThrow('The Kokoro download was canceled.');
    expect(isKokoroDownloading()).toBe(false);
    expect(cancelKokoroDownload()).toBe(false);
    expect(onProgress).toHaveBeenCalled();
  });
});

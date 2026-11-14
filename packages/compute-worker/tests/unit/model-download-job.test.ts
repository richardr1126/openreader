import { rmSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import { runModelDownload } from '../../src/jobs/model-download';
import { cancelKokoroDownload, ensureKokoroAssets, isKokoroDownloading } from '../../src/inference/kokoro/model-files';

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

  test('a superseded delivery detaches without canceling a playback download', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    vi.stubGlobal('fetch', fetchImpl);
    const controller = new AbortController();
    const job = runModelDownload({ model: 'kokoro-82m' }, 0, { signal: controller.signal });
    const observed = expect(job).rejects.toThrow('Delivery superseded');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const playback = ensureKokoroAssets();
    const playbackCanceled = expect(playback).rejects.toThrow('The Kokoro download was canceled.');
    controller.abort(new Error('Delivery superseded'));
    await observed;
    expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(false);
    expect(cancelKokoroDownload()).toBe(true);
    await playbackCanceled;
  });

  test('a new caller starts a fresh transfer while a canceled one drains', async () => {
    let finishFirst!: () => void;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })).mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => {
      finishFirst = () => reject(init?.signal?.reason);
    }));
    vi.stubGlobal('fetch', fetchImpl);
    const first = expect(ensureKokoroAssets()).rejects.toThrow('canceled');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(cancelKokoroDownload()).toBe(true);
    const next = expect(ensureKokoroAssets()).rejects.toThrow('canceled');
    finishFirst();
    await first;
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(fetchImpl.mock.calls[1][1]?.signal?.aborted).toBe(false);
    expect(cancelKokoroDownload()).toBe(true);
    await next;
  });

  test('a rejected progress listener leaves the shared transfer running', async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    const progress = vi.fn(async () => { throw new Error('Delivery superseded'); });
    vi.stubGlobal('fetch', fetchImpl);
    const first = expect(ensureKokoroAssets(progress)).rejects.toThrow('canceled');
    const second = expect(ensureKokoroAssets()).rejects.toThrow('canceled');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    expect(progress).toHaveBeenCalled();
    expect(cancelKokoroDownload()).toBe(true);
    await Promise.all([first, second]);
  });
});

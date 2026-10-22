import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ModelDownloadProgress } from '../../src/inference/model-download';
import {
  cancelKokoroDownload,
  ensureKokoroAssetFiles,
  ensureKokoroAssets,
  isKokoroDownloading,
  KOKORO_COMPONENTS,
  KOKORO_MODEL_DIR,
  KOKORO_MODEL_FILE,
  kokoroAssetStatus,
  removeKokoroAssetFiles,
} from '../../src/inference/kokoro/model-files';

const docstore = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  return mkdtempSync(path.join(tmpdir(), 'openreader-kokoro-assets-'));
});
vi.mock('../../src/infrastructure/platform', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/infrastructure/platform')>(),
  DOCSTORE_DIR: docstore,
}));

// Keep the real manifest's filenames, URLs and language/voice coverage, with
// small, genuinely checksummed files so these download tests stay offline.
const files = KOKORO_COMPONENTS.flatMap((component) => component.files);
const originalMetadata = files.map((file) => ({ size: file.size, sha256: file.sha256 }));
const bodies = new Map(files.map((file) => [file.url, Buffer.from(`asset:${file.path}`)]));
const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
  const body = bodies.get(String(input));
  if (!body) throw new Error(`Unexpected download: ${input}`);
  return new Response(new Uint8Array(body));
});
const requestedPaths = () => fetchImpl.mock.calls.map(([url]) => files.find((file) => file.url === String(url))!.path);

beforeAll(() => {
  files.forEach((file) => {
    const body = bodies.get(file.url)!;
    file.size = body.byteLength;
    file.sha256 = createHash('sha256').update(body).digest('hex');
  });
});
beforeEach(async () => {
  await removeKokoroAssetFiles();
  fetchImpl.mockClear();
  vi.stubGlobal('fetch', fetchImpl);
});
afterEach(() => { vi.unstubAllGlobals(); });
afterAll(async () => {
  files.forEach((file, index) => Object.assign(file, originalMetadata[index]));
  await rm(docstore, { recursive: true, force: true });
});

describe('on-demand Kokoro downloads', () => {
  const baselinePaths = [KOKORO_MODEL_FILE, 'voices/af_heart.bin', 'g2p/en-us.tsv', 'misaki/us_gold.json', 'misaki/us_silver.json'];
  const bytesFor = (paths: string[]) => paths.reduce((sum, name) => sum + Buffer.byteLength(`asset:${name}`), 0);

  test('default setup downloads only the baseline and becomes ready without optional assets', async () => {
    const progress: ModelDownloadProgress[] = [];
    const before = await kokoroAssetStatus();
    expect(before.map((component) => component.name)).toEqual(['Model weights', 'Voice pack', 'Pronunciation data']);
    expect(before.reduce((sum, component) => sum + component.totalBytes, 0)).toBe(bytesFor(baselinePaths));
    const productionBytes = baselinePaths.reduce((sum, name) => (
      sum + originalMetadata[files.findIndex((file) => file.path === name)]!.size
    ), 0);
    expect(productionBytes).toBe(334_628_908);

    await ensureKokoroAssets((event) => { progress.push(event); });
    expect(requestedPaths()).toEqual(baselinePaths);
    const after = await kokoroAssetStatus();
    expect(after).toHaveLength(3);
    expect(after.every((component) => component.installedBytes === component.totalBytes)).toBe(true);
    expect(progress.at(-1)?.totalBytes).toBe(bytesFor(baselinePaths));
  });

  test.each([
    { language: 'us' as const, voice: 'af_heart', data: ['g2p/en-us.tsv', 'misaki/us_gold.json', 'misaki/us_silver.json'] },
    { language: 'gb' as const, voice: 'bf_emma', data: ['g2p/en-gb.tsv', 'misaki/gb_gold.json', 'misaki/gb_silver.json'] },
    { language: 'es' as const, voice: 'ef_dora', data: ['g2p/es.tsv'] },
    { language: 'hi' as const, voice: 'hf_alpha', data: ['g2p/hi.tsv'] },
    { language: 'it' as const, voice: 'if_sara', data: ['g2p/it.tsv'] },
    { language: 'pt-br' as const, voice: 'pf_dora', data: ['g2p/pt-br.tsv'] },
  ])('downloads only $language data and the selected voice', async ({ language, voice, data }) => {
    const progress: ModelDownloadProgress[] = [];
    await ensureKokoroAssets((event) => { progress.push(event); }, { voices: [voice], language });

    expect(requestedPaths()).toEqual([KOKORO_MODEL_FILE, `voices/${voice}.bin`, ...data]);
    const last = progress.at(-1)!;
    expect(last.components?.map((component) => component.name)).toEqual(['Model weights', 'Voice pack', 'Pronunciation data']);
    expect(last.components?.every((component) => component.state === 'ready')).toBe(true);
    expect(last.totalBytes).toBe(requestedPaths().reduce((sum, name) => sum + Buffer.byteLength(`asset:${name}`), 0));
    expect(last.downloadedBytes).toBe(last.totalBytes);
    expect(isKokoroDownloading()).toBe(false);

    const warm = vi.fn();
    await ensureKokoroAssets(warm, { voices: [voice], language });
    expect(warm).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2 + data.length);
  });

  test('fetches each blend member once and only the explicit pronunciation language', async () => {
    await ensureKokoroAssets(undefined, { voices: ['af_heart', 'bf_emma', 'af_heart'], language: 'us' });
    expect(requestedPaths()).toEqual([
      KOKORO_MODEL_FILE, 'voices/af_heart.bin', 'voices/bf_emma.bin', 'g2p/en-us.tsv', 'misaki/us_gold.json', 'misaki/us_silver.json',
    ]);
  });

  test('can prepare only the model or only a language without downloading voices', async () => {
    await ensureKokoroAssets(undefined, {});
    expect(requestedPaths()).toEqual([KOKORO_MODEL_FILE]);
    await ensureKokoroAssets(undefined, { language: 'gb' });
    expect(requestedPaths()).toEqual([KOKORO_MODEL_FILE, 'g2p/en-gb.tsv', 'misaki/gb_gold.json', 'misaki/gb_silver.json']);
  });

  test('adds newly requested voices and languages to the same cache', async () => {
    await ensureKokoroAssets(undefined, { voices: ['af_heart'], language: 'us' });
    fetchImpl.mockClear();
    await ensureKokoroAssets(undefined, { voices: ['ef_dora'], language: 'es' });
    expect(requestedPaths()).toEqual(['voices/ef_dora.bin', 'g2p/es.tsv']);
    expect(await readFile(path.join(KOKORO_MODEL_DIR, 'misaki/us_gold.json'), 'utf8')).toBe('asset:misaki/us_gold.json');
  });

  test('serializes overlapping selections and default setup without duplicate downloads', async () => {
    const progress = vi.fn();
    await Promise.all([
      ensureKokoroAssets(undefined, { voices: ['af_heart'], language: 'us' }),
      ensureKokoroAssets(undefined, { voices: ['af_heart', 'ef_dora'], language: 'es' }),
      ensureKokoroAssets(progress),
    ]);
    const paths = requestedPaths();
    expect(paths).toHaveLength(7);
    expect(new Set(paths).size).toBe(7);
    expect(paths.slice(0, 5)).toEqual([
      KOKORO_MODEL_FILE, 'voices/af_heart.bin', 'g2p/en-us.tsv', 'misaki/us_gold.json', 'misaki/us_silver.json',
    ]);
    const last = progress.mock.calls.at(-1)![0] as ModelDownloadProgress;
    const status = await kokoroAssetStatus();
    expect(last.downloadedBytes).toBe(last.totalBytes);
    expect(status.reduce((sum, component) => sum + component.totalBytes, 0)).toBe(bytesFor(paths));
    expect(status.every((component) => component.installedBytes === component.totalBytes)).toBe(true);
    const warm = vi.fn();
    await ensureKokoroAssets(warm);
    expect(warm).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  test('keeps baseline readiness separate from optional installed bytes', async () => {
    await ensureKokoroAssets(undefined, { voices: ['ef_dora'], language: 'es' });
    const after = await kokoroAssetStatus();
    expect(after.map((component) => component.name)).toEqual(['Model weights', 'Voice pack', 'Pronunciation data']);
    expect(after.map((component) => component.installedBytes)).toEqual([
      bytesFor([KOKORO_MODEL_FILE]), bytesFor(['voices/ef_dora.bin']), bytesFor(['g2p/es.tsv']),
    ]);
    expect(after.every((component) => component.installedBytes === component.totalBytes)).toBe(true);
    fetchImpl.mockClear();
    await ensureKokoroAssets();
    expect(fetchImpl).not.toHaveBeenCalled();
    await ensureKokoroAssets(undefined, { voices: ['af_heart'], language: 'us' });
    expect(requestedPaths()).toEqual(baselinePaths.slice(1));
    const ready = await kokoroAssetStatus();
    expect(ready.map((component) => component.name)).toEqual([
      'Model weights', 'Voice pack', 'Pronunciation data', 'Additional voices', 'Additional pronunciation data',
    ]);
    expect(ready.every((component) => component.installedBytes === component.totalBytes)).toBe(true);
    expect(ready.reduce((sum, component) => sum + component.installedBytes, 0)).toBe(
      bytesFor([...baselinePaths, 'voices/ef_dora.bin', 'g2p/es.tsv']),
    );
  });

  test('uses the default baseline when no complete voice and pronunciation pair exists', async () => {
    const before = await kokoroAssetStatus();
    await ensureKokoroAssets(undefined, { voices: ['ef_dora'] });
    const incomplete = await kokoroAssetStatus();
    expect(incomplete.slice(0, 3).map((component) => component.totalBytes)).toEqual(before.map((component) => component.totalBytes));
    expect(incomplete.map((component) => component.installedBytes)).toEqual([
      bytesFor([KOKORO_MODEL_FILE]), 0, 0, bytesFor(['voices/ef_dora.bin']),
    ]);
    expect(incomplete.some((component) => component.installedBytes < component.totalBytes)).toBe(true);
    await ensureKokoroAssets(undefined, { language: 'es' });
    expect((await kokoroAssetStatus()).every((component) => component.installedBytes === component.totalBytes)).toBe(true);
  });

  test('chooses complete voices deterministically and prefers the complete default', async () => {
    await ensureKokoroAssets(undefined, { voices: ['if_sara'], language: 'it' });
    await ensureKokoroAssets(undefined, { voices: ['bf_emma'], language: 'gb' });
    const british = await kokoroAssetStatus();
    expect(british[2]!.totalBytes).toBe(bytesFor(['g2p/en-gb.tsv', 'misaki/gb_gold.json', 'misaki/gb_silver.json']));
    await ensureKokoroAssets(undefined, { voices: ['af_heart'], language: 'us' });
    const american = await kokoroAssetStatus();
    expect(american[2]!.totalBytes).toBe(bytesFor(['g2p/en-us.tsv', 'misaki/us_gold.json', 'misaki/us_silver.json']));
    expect(american.reduce((sum, component) => sum + component.installedBytes, 0)).toBe(
      bytesFor([...baselinePaths, 'voices/bf_emma.bin', 'g2p/en-gb.tsv', 'misaki/gb_gold.json', 'misaki/gb_silver.json', 'voices/if_sara.bin', 'g2p/it.tsv']),
    );
  });

  test('default setup joins active non-English demand without adding default assets', async () => {
    const progress = vi.fn();
    await Promise.all([
      ensureKokoroAssets(undefined, { voices: ['ef_dora'], language: 'es' }),
      ensureKokoroAssets(progress),
    ]);
    expect(requestedPaths()).toEqual([KOKORO_MODEL_FILE, 'voices/ef_dora.bin', 'g2p/es.tsv']);
    expect(progress).toHaveBeenCalled();
    expect((await kokoroAssetStatus()).every((component) => component.installedBytes === component.totalBytes)).toBe(true);
  });

  test.each([
    { language: 'us' as const, voices: ['af_heart'] },
    { language: 'es' as const, voices: ['ef_dora'] },
    { language: 'hi' as const, voices: ['hf_alpha'] },
  ])('default setup repairs same-size corrupt weights in a cold $language installation', async (selection) => {
    // The low-level installer writes real checksummed files without populating
    // ensureKokoroAssets' process-wide verified cache, like an earlier process.
    await ensureKokoroAssetFiles({ selection });
    const model = files.find((file) => file.path === KOKORO_MODEL_FILE)!;
    await writeFile(path.join(KOKORO_MODEL_DIR, KOKORO_MODEL_FILE), Buffer.alloc(model.size, 0));
    expect((await kokoroAssetStatus()).every((component) => component.installedBytes === component.totalBytes)).toBe(true);
    fetchImpl.mockClear();

    await ensureKokoroAssets();

    expect(requestedPaths()).toEqual([KOKORO_MODEL_FILE]);
    expect(await readFile(path.join(KOKORO_MODEL_DIR, KOKORO_MODEL_FILE))).toEqual(bodies.get(model.url));
    expect(isKokoroDownloading()).toBe(false);
    const warm = vi.fn();
    await ensureKokoroAssets(warm);
    expect(warm).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('reuses an older complete pack and counts all optional data for removal', async () => {
    await ensureKokoroAssetFiles({ components: KOKORO_COMPONENTS });
    fetchImpl.mockClear();
    await ensureKokoroAssets();
    expect(fetchImpl).not.toHaveBeenCalled();
    const status = await kokoroAssetStatus();
    expect(status.every((component) => component.installedBytes === component.totalBytes)).toBe(true);
    expect(status.reduce((sum, component) => sum + component.installedBytes, 0)).toBe(
      files.reduce((sum, file) => sum + file.size, 0),
    );
    await removeKokoroAssetFiles();
    expect(await kokoroAssetStatus()).toHaveLength(3);
    expect((await kokoroAssetStatus()).every((component) => component.installedBytes === 0)).toBe(true);
  });

  test('deletes files no current component names, keeping installed ones', async () => {
    const write = async (name: string, body: string) => {
      await mkdir(path.dirname(path.join(KOKORO_MODEL_DIR, name)), { recursive: true });
      await writeFile(path.join(KOKORO_MODEL_DIR, name), body);
    };
    const stale = ['onnx/model_quantized.onnx', 'voices/old_voice.bin', 'voices/af_heart.bin.tmp', 'legacy/g2p/xx.tsv'];
    for (const name of stale) await write(name, 'stale');
    await write('voices/af_heart.bin', 'asset:voices/af_heart.bin');

    await ensureKokoroAssets(undefined, { voices: ['af_heart'], language: 'us' });
    for (const name of [...stale, 'legacy']) {
      await expect(stat(path.join(KOKORO_MODEL_DIR, name))).rejects.toThrow();
    }
    expect(requestedPaths()).not.toContain('voices/af_heart.bin');
    expect(await readFile(path.join(KOKORO_MODEL_DIR, 'voices/af_heart.bin'), 'utf8')).toBe('asset:voices/af_heart.bin');
  });

  test('rejects unknown voice ids before downloading anything', async () => {
    await expect(ensureKokoroAssets(undefined, { voices: ['../af_heart'] })).rejects.toThrow(/no voice/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(isKokoroDownloading()).toBe(false);
  });

  test('removal resets readiness so the next request downloads again', async () => {
    await ensureKokoroAssets(undefined, { voices: ['af_heart'], language: 'us' });
    await removeKokoroAssetFiles();
    fetchImpl.mockClear();
    await ensureKokoroAssets(undefined, { voices: ['af_heart'], language: 'us' });
    expect(requestedPaths()).toHaveLength(5);
  });

  test('cancels active and queued requests, then permits a clean retry', async () => {
    const blockedFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', blockedFetch);
    const selected = ensureKokoroAssets(undefined, { voices: ['af_heart'], language: 'us' });
    const setup = ensureKokoroAssets();
    const results = Promise.allSettled([selected, setup]);
    await vi.waitFor(() => expect(blockedFetch).toHaveBeenCalledTimes(1));
    await expect(removeKokoroAssetFiles()).rejects.toThrow(/Cancel the download/);
    expect(cancelKokoroDownload()).toBe(true);
    expect(await results).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ message: 'The Kokoro download was canceled.' }) },
      { status: 'rejected', reason: expect.objectContaining({ message: 'The Kokoro download was canceled.' }) },
    ]);
    expect(isKokoroDownloading()).toBe(false);
    expect(cancelKokoroDownload()).toBe(false);
    await expect(stat(path.join(KOKORO_MODEL_DIR, `${KOKORO_MODEL_FILE}.tmp`))).rejects.toThrow();

    vi.stubGlobal('fetch', fetchImpl);
    await ensureKokoroAssets(undefined, { voices: ['ef_dora'], language: 'es' });
    expect(requestedPaths()).toEqual([KOKORO_MODEL_FILE, 'voices/ef_dora.bin', 'g2p/es.tsv']);
  });

  test('retries a failed selection while retaining files already verified', async () => {
    const data = files.find((file) => file.path === 'g2p/es.tsv')!;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => (
      String(input) === data.url ? new Response('corrupt') : fetchImpl(input)
    ));
    await expect(ensureKokoroAssets(undefined, { voices: ['ef_dora'], language: 'es' })).rejects.toThrow(/failed verification/);
    expect(isKokoroDownloading()).toBe(false);
    fetchImpl.mockClear();
    vi.stubGlobal('fetch', fetchImpl);
    await ensureKokoroAssets(undefined, { voices: ['ef_dora'], language: 'es' });
    expect(requestedPaths()).toEqual(['g2p/es.tsv']);
  });
});

import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ArtifactStorage } from '../../src/infrastructure/storage';
import { createDocumentAudioReporter, measureDocumentAudioBytes } from '../../src/storage/audio-usage';
import { storageUserHash } from '../../src/storage/prefix-cleanup';

const documentId = 'a'.repeat(64), other = 'b'.repeat(64);
function setup() {
  const objects = new Map([
    [`test/tts_playback_segments_audio_v1/users/reader/docs/${documentId}/1/voice/audio.mp3`, 100],
    [`test/tts_playback_segments_v1/users/${storageUserHash('reader')}/docs/${documentId}/1/voice/segments/0.json`, 20],
    [`test/tts_playback_exports_v1/users/reader/docs/${documentId}/export/artifact.mp3`, 200],
    [`test/tts_playback_segments_audio_v1/users/reader/docs/${other}/1/voice/audio.mp3`, 9999],
    [`test/tts_playback_plan_v1/${documentId}/plan.json`, 9999],
  ]);
  const prefixes: string[] = [];
  const storage = { async *listPrefixPages(prefix: string) {
    prefixes.push(prefix);
    for (const [key, size] of objects) if (key.startsWith(prefix)) yield [{ key, size, lastModifiedMs: 1 }];
  } } as unknown as ArtifactStorage;
  const requests: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ revision: 7 });
  });
  vi.stubGlobal('fetch', fetch);
  const input = { storage, s3Prefix: 'test', storageUserId: 'reader', documentId, logger: { warn: vi.fn() } };
  return { objects, prefixes, input, fetch, requests };
}
afterEach(() => vi.unstubAllGlobals());
describe('worker-owned audio accounting', () => {
  test('measures only the affected document, including sidecars and exports, without derived data', async () => {
    const { input, prefixes } = setup();
    expect(await measureDocumentAudioBytes(input)).toBe(320);
    expect(prefixes).toHaveLength(3);
    expect(prefixes.every((prefix) => prefix.includes(`/docs/${documentId}/`))).toBe(true);
  });
  test('reports the measured bytes with the broker token and throttles in-run scans', async () => {
    const { input, fetch, requests } = setup();
    const reporter = createDocumentAudioReporter(input);
    await reporter.measure(true); await reporter.measure();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0][0])).toBe('http://127.0.0.1:3003/api/internal/compute/storage');
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ Authorization: 'Bearer test-credential-broker-token' });
    expect(requests).toEqual([
      { action: 'begin', userId: 'reader', documentId },
      { action: 'report', userId: 'reader', documentId, revision: 7, audioBytes: 320 },
    ]);
  });
  test('fences a clear before deletion and measures zero afterwards', async () => {
    const { input, objects, requests } = setup();
    await createDocumentAudioReporter(input).clear(async () => {
      expect(requests[0]).toMatchObject({ action: 'begin-clear' });
      objects.clear();
    });
    expect(requests[1]).toMatchObject({ action: 'report', revision: 7, audioBytes: 0 });
  });
  test('does not delete without a fence, and repair fails visibly when the broker is down', async () => {
    const { input, fetch } = setup(); fetch.mockResolvedValue(Response.json({}, { status: 503 }));
    const clear = vi.fn(async () => undefined);
    await expect(createDocumentAudioReporter(input).clear(clear)).rejects.toThrow('503');
    expect(clear).not.toHaveBeenCalled();
    await expect(createDocumentAudioReporter(input).measure(true, true)).rejects.toThrow('503');
  });
  test('a clear lease skips concurrent measurements, and partial deletion is measured after failure', async () => {
    const { input, objects, fetch, requests, prefixes } = setup();
    fetch.mockResolvedValueOnce(Response.json({ revision: null }));
    await createDocumentAudioReporter(input).measure(true);
    expect(prefixes).toHaveLength(0);
    await expect(createDocumentAudioReporter(input).clear(async () => {
      for (const key of objects.keys()) if (key.endsWith('audio.mp3')) objects.delete(key);
      throw new Error('deletion interrupted');
    })).rejects.toThrow('deletion interrupted');
    expect(requests.at(-1)).toMatchObject({ action: 'report', audioBytes: 220 });
  });
});

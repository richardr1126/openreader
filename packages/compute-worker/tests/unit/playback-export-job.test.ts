import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

import type { ArtifactStorage } from '../../src/infrastructure/storage';
import { createTtsPlaybackExportHandler } from '../../src/jobs/playback/export-job';

const { getCbrSilenceSecond } = vi.hoisted(() => ({
  getCbrSilenceSecond: vi.fn(async () => Buffer.from('pause')),
}));

vi.mock('@openreader/tts/audio-format', () => ({ getCbrSilenceSecond }));

class MemoryStorage implements ArtifactStorage {
  async putFile(key: string, path: string): Promise<void> {
    this.objects.set(key, await readFile(path));
  }
  readonly objects = new Map<string, Buffer>();

  async readObject(key: string): Promise<ArrayBuffer> {
    const value = this.objects.get(key);
    if (!value) throw Object.assign(new Error('not found'), { name: 'NoSuchKey' });
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }

  async objectExists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async listPrefix(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  async *listPrefixPages(prefix: string) {
    yield [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, size: value.byteLength }));
  }

  async putObject(key: string, body: Buffer | Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }

  async putParsedPdf(): Promise<string> {
    throw new Error('not implemented');
  }
}

const request = {
  artifactId: 'abcdef1234567890',
  sessionId: 'session',
  userId: 'user',
  storageUserId: 'storage-user',
  documentId: 'd'.repeat(64),
  documentVersion: 1,
  readerType: 'epub' as const,
  settingsHash: 'settings',
  settingsJson: {},
  planObjectKey: 'test/plan.json',
  format: 'mp3' as const,
  speed: 1,
};

function sidecar(ordinal: number, status: 'completed' | 'error', audioKey: string) {
  return {
    schemaVersion: 1 as const,
    status,
    storageUserId: request.storageUserId,
    documentId: request.documentId,
    documentVersion: request.documentVersion,
    readerType: request.readerType,
    settingsHash: request.settingsHash,
    ordinal,
    segmentKey: null,
    textHash: `hash-${ordinal}`,
    textLength: 4,
    audioKey,
    audioFormat: 'mp3' as const,
    durationMs: status === 'completed' ? 500 : null,
    alignment: null,
    error: status === 'error' ? { message: 'unspeakable' } : null,
    updatedAt: 1,
  };
}

describe('TTS playback export job', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('assembles partial narration with a short pause for terminal segment errors', async () => {
    const storage = new MemoryStorage();
    storage.objects.set(request.planObjectKey, Buffer.from(JSON.stringify({
      schemaVersion: 1,
      segments: [
        { ordinal: 0, text: 'One.', locator: { readerType: 'epub', spineIndex: 0 } },
        { ordinal: 1, text: 'Bad.', locator: { readerType: 'epub', spineIndex: 0 } },
        { ordinal: 2, text: 'Two.', locator: { readerType: 'epub', spineIndex: 1 } },
      ],
    })));
    storage.objects.set('audio/0', Buffer.from('one'));
    storage.objects.set('audio/2', Buffer.from('two'));
    const sidecars = new Map([
      [0, sidecar(0, 'completed', 'audio/0')],
      [1, sidecar(1, 'error', 'audio/1')],
      [2, sidecar(2, 'completed', 'audio/2')],
    ]);
    const onProgress = vi.fn();
    const run = createTtsPlaybackExportHandler({
      storage,
      playbackStorage: {
        sessions: { getSession: async () => ({
          sessionId: request.sessionId,
          storageUserId: request.storageUserId,
          documentId: request.documentId,
          status: 'succeeded',
          planObjectKey: request.planObjectKey,
        }) },
        artifacts: { getScopeEpoch: async () => 0, readSegmentMetadata: async ({ ordinal }: { ordinal: number }) => sidecars.get(ordinal) ?? null },
      },
      s3Prefix: 'test',
    } as never);

    const result = await run(request, 0, { onProgress });

    expect(result.artifact).toMatchObject({
      status: 'ready', generatedSegments: 2, skippedSegments: 1, plannedSegments: 3,
    });
    expect(storage.objects.get(result.artifact.objectKey)?.toString()).toBe('onepausetwo');
    expect(onProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({
      phase: 'assembling', completedSegments: 0, plannedSegments: 3,
    }));
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({
      completedSegments: 3, plannedSegments: 3, skippedSegments: 1,
    }));
  });

  test('does not publish a misleading all-silence audiobook', async () => {
    const storage = new MemoryStorage();
    storage.objects.set(request.planObjectKey, Buffer.from(JSON.stringify({
      schemaVersion: 1,
      segments: [{ ordinal: 0, text: 'Bad.', locator: null }],
    })));
    const run = createTtsPlaybackExportHandler({
      storage,
      playbackStorage: {
        sessions: { getSession: async () => ({
          sessionId: request.sessionId,
          storageUserId: request.storageUserId,
          documentId: request.documentId,
          status: 'succeeded',
          planObjectKey: request.planObjectKey,
        }) },
        artifacts: { getScopeEpoch: async () => 0, readSegmentMetadata: async () => sidecar(0, 'error', 'audio/0') },
      },
      s3Prefix: 'test',
    } as never);

    await expect(run(request, 0)).rejects.toThrow('could not generate any narratable audio');
    expect(getCbrSilenceSecond).not.toHaveBeenCalled();
  });

  function pdfPlanStorage(): MemoryStorage {
    const storage = new MemoryStorage();
    storage.objects.set(request.planObjectKey, Buffer.from(JSON.stringify({
      schemaVersion: 1,
      segments: [
        { ordinal: 0, text: 'One.', locator: { readerType: 'pdf', page: 1 } },
        { ordinal: 1, text: 'Two.', locator: { readerType: 'pdf', page: 1 } },
        { ordinal: 2, text: 'Three.', locator: { readerType: 'pdf', page: 2 } },
      ],
    })));
    storage.objects.set('audio/0', Buffer.from('one'));
    storage.objects.set('audio/1', Buffer.from('two'));
    return storage;
  }

  function handler(storage: MemoryStorage, sidecars: Map<number, ReturnType<typeof sidecar>>, status = 'succeeded') {
    return createTtsPlaybackExportHandler({
      storage,
      playbackStorage: {
        sessions: { getSession: async () => ({
          sessionId: request.sessionId,
          storageUserId: request.storageUserId,
          documentId: request.documentId,
          status,
          planObjectKey: request.planObjectKey,
        }) },
        artifacts: { getScopeEpoch: async () => 0, readSegmentMetadata: async ({ ordinal }: { ordinal: number }) => sidecars.get(ordinal) ?? null },
      },
      s3Prefix: 'test',
    } as never);
  }

  test('exports one settled chapter while later chapters are still generating', async () => {
    const storage = pdfPlanStorage();
    const run = handler(storage, new Map([
      [0, sidecar(0, 'completed', 'audio/0')],
      [1, sidecar(1, 'completed', 'audio/1')],
    ]), 'running');

    const result = await run({ ...request, chapterIndex: 0 }, 0);

    expect(result.artifact).toMatchObject({
      chapterIndex: 0,
      generatedSegments: 2,
      skippedSegments: 0,
      plannedSegments: 2,
      dispositionFilename: 'openreader-dddddddddddd-chapter-001.mp3',
    });
    expect(storage.objects.get(result.artifact.objectKey)?.toString()).toBe('onetwo');
    await expect(run(request, 0)).rejects.toThrow('session is not complete: running');
  });

  test('rebuilds a ready artifact once retried segments change the settled counts', async () => {
    const storage = pdfPlanStorage();
    const sidecars = new Map([
      [0, sidecar(0, 'completed', 'audio/0')],
      [1, sidecar(1, 'error', 'audio/1')],
    ]);
    const run = handler(storage, sidecars);
    const first = await run({ ...request, chapterIndex: 0 }, 0);
    expect(first.artifact.skippedSegments).toBe(1);

    const reused = await run({ ...request, chapterIndex: 0 }, 0);
    expect(reused.artifact.createdAt).toBe(first.artifact.createdAt);

    sidecars.set(1, sidecar(1, 'completed', 'audio/1'));
    const rebuilt = await run({ ...request, chapterIndex: 0 }, 0);
    expect(rebuilt.artifact).toMatchObject({ generatedSegments: 2, skippedSegments: 0 });
    expect(storage.objects.get(rebuilt.artifact.objectKey)?.toString()).toBe('onetwo');
  });

  test('rebuilds a missing final file from settled cached sources', async () => {
    const storage = pdfPlanStorage();
    const run = handler(storage, new Map([
      [0, sidecar(0, 'completed', 'audio/0')], [1, sidecar(1, 'completed', 'audio/1')],
    ]));
    const first = await run({ ...request, chapterIndex: 0 }, 0);
    storage.objects.delete(first.artifact.objectKey);
    const rebuilt = await run({ ...request, chapterIndex: 0 }, 0);
    expect(storage.objects.get(rebuilt.artifact.objectKey)?.toString()).toBe('onetwo');
    expect(rebuilt.artifact.objectKey).not.toBe(first.artifact.objectKey);
  });

  test('keeps source downloads bounded and output ordered when reads complete out of order', async () => {
    const storage = new MemoryStorage();
    const segments = Array.from({ length: 40 }, (_, ordinal) => ({ ordinal, text: 'Audio.', locator: { readerType: 'pdf', page: 1 } }));
    storage.objects.set(request.planObjectKey, Buffer.from(JSON.stringify({ schemaVersion: 1, segments })));
    const sidecars = new Map(segments.map(({ ordinal }) => [ordinal, sidecar(ordinal, 'completed', `audio/${ordinal}`)]));
    for (const { ordinal } of segments) storage.objects.set(`audio/${ordinal}`, Buffer.from(`${ordinal},`));
    const readObject = storage.readObject.bind(storage);
    let active = 0;
    let maximum = 0;
    storage.readObject = async (key) => {
      if (!key.startsWith('audio/')) return readObject(key);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, Number(key.slice(6)) % 4 === 0 ? 5 : 0));
      try { return await readObject(key); } finally { active -= 1; }
    };
    const putFile = vi.spyOn(storage, 'putFile');
    const result = await handler(storage, sidecars)(request, 0);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(storage.objects.get(result.artifact.objectKey)?.toString()).toBe(segments.map(({ ordinal }) => `${ordinal},`).join(''));
    expect(putFile).toHaveBeenCalledOnce();
    const { stat } = await import('node:fs/promises');
    await expect(stat(putFile.mock.calls[0][1])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('surfaces temporary artifact reads instead of treating them as missing', async () => {
    const storage = pdfPlanStorage();
    const readObject = storage.readObject.bind(storage);
    storage.readObject = async (key) => {
      if (key.endsWith('metadata.json')) throw new Error('object storage unavailable');
      return readObject(key);
    };
    const putFile = vi.spyOn(storage, 'putFile');
    const run = handler(storage, new Map([
      [0, sidecar(0, 'completed', 'audio/0')], [1, sidecar(1, 'completed', 'audio/1')],
    ]));
    await expect(run({ ...request, chapterIndex: 0 }, 0)).rejects.toThrow('object storage unavailable');
    expect(putFile).not.toHaveBeenCalled();
  });

  test('discards its own uploaded file when cleanup invalidates the source', async () => {
    const storage = pdfPlanStorage();
    let epoch = 0;
    let uploadedKey: string | null = null;
    const putFile = storage.putFile.bind(storage);
    storage.putFile = async (key, path) => {
      await putFile(key, path);
      uploadedKey = key;
      epoch += 1;
    };
    const run = createTtsPlaybackExportHandler({
      storage, s3Prefix: 'test', playbackStorage: {
        sessions: { getSession: async () => ({ ...request, status: 'succeeded' }) },
        artifacts: { getScopeEpoch: async () => epoch,
          readSegmentMetadata: async ({ ordinal }: { ordinal: number }) => sidecar(ordinal, 'completed', `audio/${ordinal}`) },
      },
    } as never);
    await expect(run({ ...request, chapterIndex: 0 }, 0)).rejects.toThrow('sources were cleared');
    expect(uploadedKey).not.toBeNull();
    expect(storage.objects.has(uploadedKey!)).toBe(false);
    expect([...storage.objects.keys()].some((key) => key.endsWith('metadata.json'))).toBe(false);
  });

  test('refuses a whole-book export from a usage-limited run', async () => {
    const storage = pdfPlanStorage();
    const run = createTtsPlaybackExportHandler({
      storage,
      playbackStorage: {
        sessions: { getSession: async () => ({
          sessionId: request.sessionId,
          storageUserId: request.storageUserId,
          documentId: request.documentId,
          status: 'succeeded',
          stopReason: 'usage_limit',
          planObjectKey: request.planObjectKey,
        }) },
        artifacts: { readSegmentMetadata: async () => null },
      },
      s3Prefix: 'test',
    } as never);

    await expect(run(request, 0)).rejects.toThrow('session is not complete: usage_limit');
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { ArtifactStorage } from '../../src/infrastructure/storage';
import { createTtsPlaybackExportHandler } from '../../src/jobs/playback/export-job';

const { getCbrSilenceSecond } = vi.hoisted(() => ({
  getCbrSilenceSecond: vi.fn(async () => Buffer.from('pause')),
}));

vi.mock('@openreader/tts/audio-format', () => ({ getCbrSilenceSecond }));

class MemoryStorage implements ArtifactStorage {
  readonly objects = new Map<string, Buffer>();

  async readObject(key: string): Promise<ArrayBuffer> {
    const value = this.objects.get(key);
    if (!value) throw new Error('not found');
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
        artifacts: { readSegmentMetadata: async ({ ordinal }: { ordinal: number }) => sidecars.get(ordinal) ?? null },
      },
      s3Prefix: 'test',
    } as never);

    const result = await run(request, 0, { onProgress });

    expect(result.artifact).toMatchObject({
      status: 'ready', generatedSegments: 2, skippedSegments: 1, plannedSegments: 3,
    });
    expect(storage.objects.get(result.artifact.objectKey)?.toString()).toBe('onepausetwo');
    expect(onProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({
      completedSegments: 1, plannedSegments: 3, skippedSegments: 1,
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
        artifacts: { readSegmentMetadata: async () => sidecar(0, 'error', 'audio/0') },
      },
      s3Prefix: 'test',
    } as never);

    await expect(run(request, 0)).rejects.toThrow('could not generate any narratable audio');
    expect(getCbrSilenceSecond).not.toHaveBeenCalled();
  });
});

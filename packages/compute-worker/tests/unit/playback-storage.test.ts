import { describe, expect, test } from 'vitest';
import type { ArtifactStorage } from '../../src/infrastructure/storage';
import type { KvEntryLike, KvStoreLike } from '../../src/infrastructure/nats-adapters';
import {
  createTtsPlaybackKvStore,
  createTtsPlaybackSegmentArtifactStore,
} from '../../src/playback/storage';

class MemoryKv implements KvStoreLike {
  private revision = 0;
  private readonly rows = new Map<string, KvEntryLike>();

  async get(key: string): Promise<KvEntryLike | null> {
    return this.rows.get(key) ?? null;
  }

  async put(key: string, data: Uint8Array): Promise<unknown> {
    this.revision += 1;
    this.rows.set(key, { operation: 'PUT', value: data, revision: this.revision });
  }

  async create(key: string, data: Uint8Array): Promise<unknown> {
    if (this.rows.has(key)) throw new Error('key exists');
    await this.put(key, data);
  }

  async update(key: string, data: Uint8Array, version: number): Promise<unknown> {
    const current = this.rows.get(key);
    if (!current || current.revision !== version) throw new Error('wrong last sequence');
    await this.put(key, data);
  }

  async keys(filter?: string | string[]): Promise<AsyncIterable<string>> {
    const filters = Array.isArray(filter) ? filter : filter ? [filter] : [];
    const keys = [...this.rows.keys()].filter((key) => {
      if (filters.length === 0) return true;
      return filters.some((item) => key.startsWith(item.replace(/\*$/, '')));
    });
    return (async function* () {
      yield* keys;
    })();
  }
}

class MemoryStorage implements ArtifactStorage {
  readonly objects = new Map<string, Buffer>();

  async readObject(key: string): Promise<ArrayBuffer> {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error('not found');
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async objectExists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async putObject(key: string, body: Buffer | Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }

  async putParsedPdf(): Promise<string> {
    throw new Error('not implemented');
  }
}

describe('TTS playback storage', () => {
  test('stores sessions and updates cursors in KV', async () => {
    const kv = new MemoryKv();
    const store = createTtsPlaybackKvStore({ getKv: async () => kv });

    await store.putSession({
      schemaVersion: 1,
      sessionId: 'session-1',
      userId: 'user-1',
      storageUserId: 'storage-1',
      documentId: 'a'.repeat(64),
      documentVersion: 1,
      readerType: 'pdf',
      status: 'queued',
      settingsHash: 'settings-hash',
      settingsJson: { voice: 'v' },
      startOrdinal: 0,
      generationStartOrdinal: 0,
      cursorOrdinal: 0,
      cursorUpdatedAt: null,
      planObjectKey: null,
      expiresAt: 1234,
      lastError: null,
      updatedAt: 100,
    });

    await store.updateCursor('session-1', 42, 200);

    expect(await store.getSession('session-1')).toMatchObject({
      sessionId: 'session-1',
      cursorOrdinal: 42,
      cursorUpdatedAt: 200,
      updatedAt: 200,
    });
  });

  test('claims segments with CAS and permits stale takeover', async () => {
    const kv = new MemoryKv();
    const store = createTtsPlaybackKvStore({ getKv: async () => kv });
    const claimInput = {
      storageUserId: 'storage-1',
      documentId: 'b'.repeat(64),
      documentVersion: 7,
      settingsHash: 'settings-hash',
      segmentId: 'c'.repeat(64),
      audioKey: 'openreader/audio.mp3',
      staleAfterMs: 1_000,
    };

    await expect(store.claimSegment({ ...claimInput, ownerId: 'one', now: 1_000 }))
      .resolves.toMatchObject({ claimed: true, claim: { ownerId: 'one' } });
    await expect(store.claimSegment({ ...claimInput, ownerId: 'two', now: 1_500 }))
      .resolves.toMatchObject({ claimed: false, claim: { ownerId: 'one' } });
    await expect(store.claimSegment({ ...claimInput, ownerId: 'two', now: 2_500 }))
      .resolves.toMatchObject({ claimed: true, claim: { ownerId: 'two' } });

    await store.markSegmentClaim({ ...claimInput, status: 'completed', ownerId: 'two', now: 3_000 });
    await expect(store.claimSegment({ ...claimInput, ownerId: 'three', now: 5_000 }))
      .resolves.toMatchObject({ claimed: false, claim: { status: 'completed', ownerId: 'two' } });
  });

  test('writes segment metadata and a compact sorted index to S3 storage', async () => {
    const storage = new MemoryStorage();
    const store = createTtsPlaybackSegmentArtifactStore({ storage, s3Prefix: 'openreader' });
    const scope = {
      storageUserId: 'storage-1',
      documentId: 'd'.repeat(64),
      documentVersion: 3,
      settingsHash: 'settings-hash',
    };

    await store.putSegmentMetadata({
      schemaVersion: 1,
      ...scope,
      readerType: 'pdf',
      settingsJson: { voice: 'v' },
      status: 'completed',
      segmentId: 'e'.repeat(64),
      segmentEntryId: 'entry-2',
      segmentIndex: 2,
      segmentKey: 'seg-2',
      textHash: 'f'.repeat(64),
      textLength: 10,
      audioKey: 'openreader/audio-2.mp3',
      audioFormat: 'mp3',
      durationMs: 1234,
      alignment: null,
      error: null,
      updatedAt: 20,
    });
    await store.putSegmentMetadata({
      schemaVersion: 1,
      ...scope,
      readerType: 'pdf',
      status: 'completed',
      segmentId: 'a'.repeat(64),
      segmentEntryId: 'entry-1',
      segmentIndex: 1,
      segmentKey: 'seg-1',
      textHash: 'b'.repeat(64),
      textLength: 12,
      audioKey: 'openreader/audio-1.mp3',
      audioFormat: 'mp3',
      durationMs: 987,
      alignment: null,
      error: null,
      updatedAt: 10,
    });

    const index = await store.readSegmentIndex(scope);
    expect(index?.segments.map((segment) => segment.segmentIndex)).toEqual([1, 2]);
    expect(index?.segments[0]).toMatchObject({
      segmentId: 'a'.repeat(64),
      metadataKey: expect.stringContaining('/segments/'),
      audioKey: 'openreader/audio-1.mp3',
      durationMs: 987,
      status: 'completed',
    });
  });
});

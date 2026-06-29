import { describe, expect, test } from 'vitest';
import type { ArtifactStorage } from '../../src/infrastructure/storage';
import type { KvEntryLike, KvStoreLike } from '../../src/infrastructure/nats-adapters';
import {
  createTtsPlaybackKvStore,
  createTtsPlaybackStorage,
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
    return undefined;
  }

  async create(key: string, data: Uint8Array): Promise<unknown> {
    if (this.rows.has(key)) throw new Error('key exists');
    await this.put(key, data);
    return undefined;
  }

  async update(key: string, data: Uint8Array, version: number): Promise<unknown> {
    const current = this.rows.get(key);
    if (!current || current.revision !== version) throw new Error('wrong last sequence');
    await this.put(key, data);
    return undefined;
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
      generationStartOrdinal: 0,
      cursorOrdinal: 0,
      cursorUpdatedAt: null,
      planObjectKey: null,
      expiresAt: 1234,
      lastError: null,
      updatedAt: 100,
    });

    await store.updateCursor('session-1', 42, 200);

    // The cursor lives on its own key (plain put, last-write-wins) and is
    // overlaid onto the record on read. A cursor update does NOT rewrite the
    // worker-owned record, so the record's own `updatedAt` stays put — this is
    // what keeps the heartbeat from contending with status writes.
    expect(await store.getSession('session-1')).toMatchObject({
      sessionId: 'session-1',
      cursorOrdinal: 42,
      cursorUpdatedAt: 200,
      updatedAt: 100,
    });
  });

  test('cursor updates never use CAS (no wrong-last-sequence under contention)', async () => {
    // A KV that rejects every CAS write — proving the cursor/session paths use
    // plain puts only. If any of them reach for kv.update, this throws.
    class NoCasKv extends MemoryKv {
      async update(): Promise<unknown> {
        throw new Error('wrong last sequence');
      }
    }
    const kv = new NoCasKv();
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
      generationStartOrdinal: 0,
      cursorOrdinal: 0,
      cursorUpdatedAt: null,
      planObjectKey: null,
      expiresAt: 1234,
      lastError: null,
      updatedAt: 100,
    });

    // Many racing cursor writers + a concurrent status patch — all plain puts.
    await Promise.all([
      ...Array.from({ length: 25 }, (_, i) => store.updateCursor('session-1', i, 1000 + i)),
      store.patchSession('session-1', { status: 'running', updatedAt: 1100 }),
      store.patchSession('session-1', { cursorOrdinal: 5, cursorUpdatedAt: 1200, updatedAt: 1200 }),
    ]);

    const session = await store.getSession('session-1');
    expect(session?.status).toBe('running');
    expect(session?.cursorOrdinal).toBeGreaterThanOrEqual(0);
  });

  test('cancels active sessions matching a playback artifact scope', async () => {
    const kv = new MemoryKv();
    const store = createTtsPlaybackKvStore({ getKv: async () => kv });
    const base = {
      schemaVersion: 1 as const,
      userId: 'user-1',
      storageUserId: 'storage-1',
      documentId: 'a'.repeat(64),
      documentVersion: 2,
      readerType: 'pdf' as const,
      settingsHash: 'settings-a',
      settingsJson: { voice: 'v' },
      generationStartOrdinal: 0,
      cursorOrdinal: 0,
      cursorUpdatedAt: null,
      planObjectKey: null,
      expiresAt: 1234,
      lastError: null,
      updatedAt: 100,
    };

    await store.putSession({ ...base, sessionId: 'queued', status: 'queued' });
    await store.putSession({ ...base, sessionId: 'running', status: 'running' });
    await store.putSession({ ...base, sessionId: 'succeeded', status: 'succeeded' });
    await store.putSession({ ...base, sessionId: 'failed', status: 'failed' });
    await store.putSession({
      ...base,
      sessionId: 'other-settings',
      status: 'running',
      settingsHash: 'settings-b',
    });

    const canceled = await store.cancelSessionsForScope({
      storageUserId: 'storage-1',
      documentId: 'a'.repeat(64),
      documentVersion: 2,
      settingsHash: 'settings-a',
    }, 500);

    expect(canceled).toBe(3);
    expect(await store.getSession('queued')).toMatchObject({ status: 'canceled', updatedAt: 500 });
    expect(await store.getSession('running')).toMatchObject({ status: 'canceled', updatedAt: 500 });
    expect(await store.getSession('succeeded')).toMatchObject({ status: 'canceled', updatedAt: 500 });
    expect(await store.getSession('failed')).toMatchObject({ status: 'failed' });
    expect(await store.getSession('other-settings')).toMatchObject({ status: 'running' });
  });

  test('increments playback artifact cache epochs by document scope', async () => {
    const kv = new MemoryKv();
    const storage = new MemoryStorage();
    const store = createTtsPlaybackStorage({
      getKv: async () => kv,
      storage,
      s3Prefix: 'openreader',
    });
    const scopeA = {
      storageUserId: 'storage-1',
      documentId: 'a'.repeat(64),
      documentVersion: 2,
      settingsHash: 'settings-a',
    };
    const scopeB = { ...scopeA, settingsHash: 'settings-b' };

    expect(await store.artifacts.getScopeEpoch(scopeA)).toBe(0);
    expect(await store.artifacts.incrementScopeEpoch({
      storageUserId: 'storage-1',
      documentId: 'a'.repeat(64),
      documentVersion: 2,
    }, 100)).toBe(1);
    expect(await store.artifacts.getScopeEpoch(scopeA)).toBe(1);
    expect(await store.artifacts.getScopeEpoch(scopeB)).toBe(1);
    expect(await store.artifacts.incrementScopeEpoch(scopeA, 200)).toBe(1);
    expect(await store.artifacts.getScopeEpoch(scopeA)).toBe(1);
    expect(await store.artifacts.getScopeEpoch(scopeB)).toBe(1);
    expect(await store.artifacts.incrementScopeEpoch({
      storageUserId: 'storage-1',
      documentId: 'a'.repeat(64),
    }, 300)).toBe(1);
    expect(await store.artifacts.getScopeEpoch(scopeA)).toBe(1);
    expect(await store.artifacts.getScopeEpoch({ ...scopeA, documentVersion: 9 })).toBe(1);
  });

  test('writes and reads per-ordinal segment sidecars (no aggregate index)', async () => {
    const storage = new MemoryStorage();
    const store = createTtsPlaybackSegmentArtifactStore({ storage, s3Prefix: 'openreader' });
    const scope = {
      storageUserId: 'storage-1',
      documentId: 'd'.repeat(64),
      documentVersion: 3,
      settingsHash: 'settings-hash',
    };

    const key2 = await store.putSegmentMetadata({
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

    // Each segment is its own object, addressable directly by ordinal.
    expect(key2).toBe(store.sidecarKey({ ...scope, segmentIndex: 2 }));
    expect(store.sidecarKey({ ...scope, segmentIndex: 1 })).toContain('/segments/1.json');

    const sidecar1 = await store.readSegmentMetadata({ ...scope, segmentIndex: 1 });
    expect(sidecar1).toMatchObject({
      segmentId: 'a'.repeat(64),
      segmentIndex: 1,
      audioKey: 'openreader/audio-1.mp3',
      durationMs: 987,
      status: 'completed',
    });
    const sidecar2 = await store.readSegmentMetadata({ ...scope, segmentIndex: 2 });
    expect(sidecar2?.durationMs).toBe(1234);
    // A not-yet-generated ordinal has no sidecar.
    expect(await store.readSegmentMetadata({ ...scope, segmentIndex: 3 })).toBeNull();
  });
});

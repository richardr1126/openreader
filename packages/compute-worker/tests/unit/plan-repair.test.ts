import { expect, test, vi } from 'vitest';
import { buildTtsPlaybackSegmentAudioKey } from '@openreader/tts/segments';
import type { ArtifactStorage } from '../../src/infrastructure/storage';
import { repairSegmentsForPlan } from '../../src/playback/plan-repair';
import {
  createTtsPlaybackSegmentArtifactStore,
  type TtsPlaybackSegmentMetadata,
  type TtsPlaybackSessionState,
  type TtsPlaybackStorage,
} from '../../src/playback/storage';

const PREFIX = 'openreader';
const scope = { storageUserId: 'user-1', documentId: 'c'.repeat(64), documentVersion: 4, settingsHash: 'settings-1' };
const OLD_PLAN = `${PREFIX}/tts_playback_plan_v1/${scope.documentId}/4/pdf/aaaaaaaa.json`;
const NEW_PLAN = `${PREFIX}/tts_playback_plan_v1/${scope.documentId}/4/pdf/bbbbbbbb.json`;
const audioKey = (hash: string) => buildTtsPlaybackSegmentAudioKey({
  storagePrefix: PREFIX, namespace: null, userId: scope.storageUserId, documentId: scope.documentId,
  documentVersion: scope.documentVersion, settingsHash: scope.settingsHash, audioContentHash: hash,
});

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  const storage = {
    async readObject(key: string) {
      const bytes = objects.get(key);
      if (!bytes) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    async objectExists(key: string) { return objects.has(key); },
    async deleteObject(key: string) { objects.delete(key); },
    async listPrefix(prefix: string) { return [...objects.keys()].filter((key) => key.startsWith(prefix)); },
    async *listPrefixPages() {},
    async listChildPrefixes() { return []; },
    async putObject(key: string, body: Buffer | Uint8Array) { objects.set(key, Buffer.from(body)); },
    async putFile() {},
    async putParsedPdf() { throw new Error('unused'); },
  } satisfies ArtifactStorage;
  return { storage, objects };
}

function sidecar(ordinal: number, segmentKey: string): TtsPlaybackSegmentMetadata {
  return {
    schemaVersion: 1, status: 'completed', ...scope, readerType: 'pdf', ordinal, segmentKey, textLength: 10,
    audioKey: audioKey(segmentKey), audioFormat: 'mp3', durationMs: 1000 + ordinal,
    alignment: { sentenceIndex: ordinal, sentence: segmentKey, words: [] }, error: null, updatedAt: 1,
  };
}

function session(sessionId: string, planObjectKey: string): TtsPlaybackSessionState {
  return {
    schemaVersion: 1, sessionId, userId: 'user-1', ...scope, readerType: 'pdf', status: 'running', settingsJson: {},
    generationStartOrdinal: 0, cursorOrdinal: 0, cursorUpdatedAt: null, planObjectKey,
    expiresAt: Date.now() + 60_000, lastError: null, updatedAt: 1,
  };
}

test('a reparsed plan reuses moved passages and deletes the earlier layout\'s other audio, once', async () => {
  const { storage, objects } = memoryStorage();
  const artifacts = createTtsPlaybackSegmentArtifactStore({ storage, s3Prefix: PREFIX });
  // The earlier layout narrated A, B, C; the reparsed one narrates B, then a new D.
  for (const [ordinal, key] of ['A', 'B', 'C'].entries()) {
    await artifacts.putSegmentMetadata(sidecar(ordinal, key));
    await storage.putObject(audioKey(key), Buffer.from(key));
  }
  const patchSession = vi.fn(async () => undefined);
  const playbackStorage = {
    artifacts,
    sessions: {
      listSessions: async () => [session('old-tab', OLD_PLAN), session('current', NEW_PLAN)],
      patchSession,
    },
  } as unknown as TtsPlaybackStorage;
  let fencedClears = 0;
  const clearAudio = async <T>(run: () => Promise<T>): Promise<T> => { fencedClears += 1; return run(); };
  const repair = () => repairSegmentsForPlan({
    storage, playbackStorage, s3Prefix: PREFIX, scope, planObjectKey: NEW_PLAN,
    plannedSegments: [{ ordinal: 0, segmentKey: 'B' }, { ordinal: 1, segmentKey: 'D' }], clearAudio,
    planIsCurrent: async () => true,
  });

  await expect(repair()).resolves.toEqual({ relinked: 1, removedSidecars: 2, deletedAudio: 2, canceledSessions: 1 });
  expect(patchSession).toHaveBeenCalledWith('old-tab', expect.objectContaining({ status: 'canceled' }));
  expect(patchSession).toHaveBeenCalledTimes(1);

  // B moved to the first position with its audio, duration and word timing.
  await expect(artifacts.readSegmentMetadata({ ...scope, ordinal: 0, segmentKey: 'B' })).resolves.toMatchObject({
    ordinal: 0, audioKey: audioKey('B'), durationMs: 1001, alignment: { sentenceIndex: 0, sentence: 'B' },
  });
  // D was never spoken, and the earlier layout's third position is gone.
  await expect(artifacts.listSegmentOrdinals(scope)).resolves.toEqual([0]);
  expect(objects.has(audioKey('B'))).toBe(true);
  expect(objects.has(audioKey('A'))).toBe(false);
  expect(objects.has(audioKey('C'))).toBe(false);
  expect(fencedClears).toBe(1);

  await expect(repair()).resolves.toBeNull();
  expect(patchSession).toHaveBeenCalledTimes(1);
});

test('a failed audio deletion leaves every record for the next repair', async () => {
  const { storage } = memoryStorage();
  const artifacts = createTtsPlaybackSegmentArtifactStore({ storage, s3Prefix: PREFIX });
  await artifacts.putSegmentMetadata(sidecar(0, 'A'));
  const playbackStorage = {
    artifacts,
    sessions: { listSessions: async () => [], patchSession: async () => undefined },
  } as unknown as TtsPlaybackStorage;
  const input = {
    storage, playbackStorage, s3Prefix: PREFIX, scope, planObjectKey: NEW_PLAN,
    plannedSegments: [{ ordinal: 0, segmentKey: 'D' }],
    planIsCurrent: async () => true,
  };
  await expect(repairSegmentsForPlan({ ...input, clearAudio: async () => { throw new Error('fence unavailable'); } }))
    .rejects.toThrow('fence unavailable');
  await expect(artifacts.readSegmentMetadata({ ...scope, ordinal: 0, segmentKey: null })).resolves.toMatchObject({ segmentKey: 'A' });
  await expect(repairSegmentsForPlan({ ...input, clearAudio: async (run) => run() }))
    .resolves.toMatchObject({ removedSidecars: 1, deletedAudio: 1 });
});

test('a failed snapshot read leaves the repair to run again', async () => {
  const { storage, artifacts, playbackStorage } = abScope();
  await artifacts.putSegmentMetadata(sidecar(0, 'A'));
  await artifacts.putSegmentMetadata(sidecar(1, 'B'));
  const flakyKey = artifacts.sidecarKey({ ...scope, ordinal: 1 });
  const readObject = storage.readObject.bind(storage);
  let failures = 1;
  storage.readObject = async (key: string) => {
    if (key === flakyKey && failures > 0) { failures -= 1; throw new Error('storage unavailable'); }
    return readObject(key);
  };
  const repair = () => repairSegmentsForPlan({
    storage, playbackStorage, s3Prefix: PREFIX, scope, planObjectKey: NEW_PLAN,
    plannedSegments: [{ ordinal: 0, segmentKey: 'D' }], clearAudio: async (run) => run(), planIsCurrent: async () => true,
  });
  await expect(repair()).rejects.toThrow('storage unavailable');
  await expect(repair()).resolves.toMatchObject({ removedSidecars: 2 });
  await expect(artifacts.listSegmentOrdinals(scope)).resolves.toEqual([]);
});

test('an unreadable record is removed rather than left behind the marker', async () => {
  const { storage, artifacts, playbackStorage } = abScope();
  await storage.putObject(artifacts.sidecarKey({ ...scope, ordinal: 0 }), Buffer.from('{not json'));
  await expect(repairSegmentsForPlan({
    storage, playbackStorage, s3Prefix: PREFIX, scope, planObjectKey: NEW_PLAN,
    plannedSegments: [{ ordinal: 0, segmentKey: 'D' }], clearAudio: async (run) => run(), planIsCurrent: async () => true,
  })).resolves.toMatchObject({ removedSidecars: 1 });
  await expect(artifacts.listSegmentOrdinals(scope)).resolves.toEqual([]);
});

function abScope() {
  const { storage, objects } = memoryStorage();
  const artifacts = createTtsPlaybackSegmentArtifactStore({ storage, s3Prefix: PREFIX });
  const patchSession = vi.fn(async () => undefined);
  const playbackStorage = {
    artifacts,
    sessions: { listSessions: async () => [session('old-tab', OLD_PLAN)], patchSession },
  } as unknown as TtsPlaybackStorage;
  return { storage, objects, artifacts, playbackStorage, patchSession };
}

test('a repair overtaken by another reparse changes nothing', async () => {
  const { storage, objects, artifacts, playbackStorage, patchSession } = abScope();
  for (const [ordinal, key] of ['A', 'B'].entries()) {
    await artifacts.putSegmentMetadata(sidecar(ordinal, key));
    await storage.putObject(audioKey(key), Buffer.from(key));
  }
  const before = new Map(objects);
  await expect(repairSegmentsForPlan({
    storage, playbackStorage, s3Prefix: PREFIX, scope, planObjectKey: NEW_PLAN,
    plannedSegments: [{ ordinal: 0, segmentKey: 'D' }], clearAudio: async (run) => run(),
    planIsCurrent: async () => false,
  })).resolves.toBeNull();
  expect(patchSession).not.toHaveBeenCalled();
  expect(objects).toEqual(before);
});

test('a record written for the new plan after the snapshot is kept', async () => {
  const { storage, artifacts, playbackStorage } = abScope();
  for (const [ordinal, key] of ['A', 'B'].entries()) await artifacts.putSegmentMetadata(sidecar(ordinal, key));
  await expect(repairSegmentsForPlan({
    storage, playbackStorage, s3Prefix: PREFIX, scope, planObjectKey: NEW_PLAN,
    plannedSegments: [{ ordinal: 0, segmentKey: 'B' }, { ordinal: 1, segmentKey: 'D' }],
    clearAudio: async (run) => run(),
    // Generation, or a faster repair, speaks D while this one is deciding.
    planIsCurrent: async () => { await artifacts.putSegmentMetadata({ ...sidecar(1, 'D'), updatedAt: 2 }); return true; },
  })).resolves.toMatchObject({ relinked: 1, removedSidecars: 0 });
  await expect(artifacts.readSegmentMetadata({ ...scope, ordinal: 1, segmentKey: 'D' })).resolves.toMatchObject({ segmentKey: 'D' });
  await expect(artifacts.readSegmentMetadata({ ...scope, ordinal: 0, segmentKey: 'B' })).resolves.toMatchObject({ ordinal: 0 });
});

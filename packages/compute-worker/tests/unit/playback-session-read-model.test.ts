import { describe, expect, test, vi } from 'vitest';
import type { ArtifactStorage } from '../../src/infrastructure/storage';
import type {
  TtsPlaybackSegmentMetadata,
  TtsPlaybackSessionState,
  TtsPlaybackStorage,
} from '../../src/playback/storage';
import { createPlaybackSessionReadModel } from '../../src/api/playback/session-read-model';

const session: TtsPlaybackSessionState = {
  schemaVersion: 1,
  sessionId: 'session-1',
  userId: 'user-1',
  storageUserId: 'storage-1',
  documentId: 'document-1',
  documentVersion: 2,
  readerType: 'pdf',
  status: 'running',
  settingsHash: 'settings-1',
  settingsJson: {},
  generationStartOrdinal: 0,
  cursorOrdinal: 0,
  cursorUpdatedAt: null,
  planObjectKey: 'openreader/plans/document-1.json',
  expiresAt: Date.now() + 60_000,
  lastError: null,
  updatedAt: 1,
};

function completedSidecar(ordinal: number, cacheEpoch = 0): TtsPlaybackSegmentMetadata {
  return {
    schemaVersion: 1,
    cacheEpoch,
    status: 'completed',
    storageUserId: session.storageUserId,
    documentId: session.documentId,
    documentVersion: session.documentVersion,
    readerType: session.readerType,
    settingsHash: session.settingsHash,
    ordinal,
    segmentKey: `segment-${ordinal}`,
    textHash: 'a'.repeat(64),
    textLength: 10,
    audioKey: `audio-${ordinal}.mp3`,
    audioFormat: 'mp3',
    durationMs: 1200,
    alignment: null,
    error: null,
    updatedAt: 10,
  };
}

function createFixture() {
  const objects = new Map<string, Buffer>([[
    session.planObjectKey!,
    Buffer.from(JSON.stringify({ segments: [{ ordinal: 0, text: 'Hello world.' }] })),
  ]]);
  let epoch = 0;
  const sidecars = new Map<number, TtsPlaybackSegmentMetadata>();
  const readSegmentMetadata = vi.fn(async ({ ordinal }: { ordinal: number }) => sidecars.get(ordinal) ?? null);
  const storage = {
    async readObject(key: string) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error('missing');
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    async objectExists(key: string) { return objects.has(key); },
    async deleteObject() {},
    async listPrefix() { return []; },
    async putObject() {},
    async putParsedPdf() { throw new Error('unused'); },
  } satisfies ArtifactStorage;
  const playbackStorage = {
    sessions: {
      async getSession(sessionId: string) { return sessionId === session.sessionId ? session : null; },
      async putSession() {},
      async patchSession() {},
      async updateCursor() {},
      async listSessions() { return []; },
      async cancelSessionsForScope() { return 0; },
    },
    artifacts: {
      sidecarKey() { return ''; },
      async putSegmentMetadata() { return ''; },
      readSegmentMetadata,
      async getScopeEpoch() { return epoch; },
      async incrementScopeEpoch() { epoch += 1; return epoch; },
    },
  } satisfies TtsPlaybackStorage;
  return {
    model: createPlaybackSessionReadModel({ storage, playbackStorage }),
    objects,
    sidecars,
    readSegmentMetadata,
    setEpoch(value: number) { epoch = value; },
  };
}

describe('playback session read model', () => {
  test('caches only completed sidecars and re-reads missing ordinals', async () => {
    const fixture = createFixture();
    fixture.sidecars.set(0, completedSidecar(0));

    await expect(fixture.model.readSegmentState(session, 0)).resolves.toMatchObject({ status: 'completed' });
    await expect(fixture.model.readSegmentState(session, 0)).resolves.toMatchObject({ status: 'completed' });
    expect(fixture.readSegmentMetadata).toHaveBeenCalledTimes(1);

    await expect(fixture.model.readSegmentState(session, 1)).resolves.toEqual({ status: 'pending', ordinal: 1 });
    await expect(fixture.model.readSegmentState(session, 1)).resolves.toEqual({ status: 'pending', ordinal: 1 });
    expect(fixture.readSegmentMetadata).toHaveBeenCalledTimes(3);
  });

  test('does not serve completed sidecars from an older cache epoch', async () => {
    const fixture = createFixture();
    fixture.sidecars.set(0, completedSidecar(0, 0));
    await expect(fixture.model.readSegmentState(session, 0)).resolves.toMatchObject({ status: 'completed' });

    fixture.setEpoch(1);
    await expect(fixture.model.readSegmentState(session, 0)).resolves.toEqual({ status: 'pending', ordinal: 0 });
    expect(fixture.readSegmentMetadata).toHaveBeenCalledTimes(2);
  });

  test('invalidates cached sidecars by exact scope and parsed plans by prefix', async () => {
    const fixture = createFixture();
    fixture.sidecars.set(0, completedSidecar(0));
    await fixture.model.readSegmentState(session, 0);
    expect(fixture.model.invalidateSidecarsForScope({
      storageUserId: session.storageUserId,
      documentId: session.documentId,
      documentVersion: session.documentVersion,
      settingsHash: session.settingsHash,
    })).toBe(1);
    await fixture.model.readSegmentState(session, 0);
    expect(fixture.readSegmentMetadata).toHaveBeenCalledTimes(2);

    await expect(fixture.model.readPlanSegments(session.planObjectKey!)).resolves.toHaveLength(1);
    fixture.objects.set(session.planObjectKey!, Buffer.from(JSON.stringify({ segments: [{ ordinal: 1, text: 'New.' }] })));
    await expect(fixture.model.readPlanSegments(session.planObjectKey!)).resolves.toMatchObject([{ ordinal: 0 }]);
    expect(fixture.model.invalidatePlansUnderPrefix('openreader/plans/')).toBe(1);
    await expect(fixture.model.readPlanSegments(session.planObjectKey!)).resolves.toMatchObject([{ ordinal: 1 }]);
  });
});

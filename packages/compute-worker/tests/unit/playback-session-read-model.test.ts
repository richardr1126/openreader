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
    alignment: {
      sentenceIndex: ordinal,
      sentence: `Segment ${ordinal}.`,
      words: [{
        text: 'Segment',
        startSec: 0,
        endSec: 0.5,
        charStart: 0,
        charEnd: 7,
      }],
    },
    error: null,
    updatedAt: 10,
  };
}

function createFixture(planLength = 100) {
  const planSegments = Array.from({ length: planLength }, (_, ordinal) => ({
    ordinal,
    text: `Segment ${ordinal}.`,
  }));
  const objects = new Map<string, Buffer>([[
    session.planObjectKey!,
    Buffer.from(JSON.stringify({ segments: planSegments })),
  ]]);
  let epoch = 0;
  const sidecars = new Map<number, TtsPlaybackSegmentMetadata>();
  const readSegmentMetadata = vi.fn(async ({ ordinal }: { ordinal: number }) => sidecars.get(ordinal) ?? null);
  const listSegmentOrdinals = vi.fn(async () => [...sidecars.keys()].sort((a, b) => a - b));
  const storage = {
    async readObject(key: string) {
      const bytes = objects.get(key);
      if (!bytes) throw new Error('missing');
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    async objectExists(key: string) { return objects.has(key); },
    async deleteObject() {},
    async listPrefix() { return []; },
    async *listPrefixPages() {},
    async putObject() {},
    async putFile() {},
    async putParsedPdf() { throw new Error('unused'); },
  } satisfies ArtifactStorage;
  const playbackStorage = {
    sessions: {
      async getSession(sessionId: string) { return sessionId === session.sessionId ? session : null; },
      async putSessionIfNewer() { return true; },
      async patchSession() {},
      async patchSessionIfGenerationRun() { return true; },
      async updateCursor() { return true; },
      async watchGenerationInvalidation() { return () => undefined; },
      async listSessions() { return []; },
      async cancelSessionsForScope() { return 0; },
    },
    artifacts: {
      sidecarKey() { return ''; },
      listSegmentOrdinals,
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
    listSegmentOrdinals,
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

  test('does not invent word timing for audio-first sidecars', async () => {
    const fixture = createFixture();
    const audioFirst = { ...completedSidecar(0), alignment: null };
    fixture.sidecars.set(0, audioFirst);

    const audioFirstRows = await fixture.model.readSegmentIndexRows(session, { minOrdinal: 0, limit: 1 });
    expect(audioFirstRows[0]?.alignmentSource).toBeNull();
    expect(audioFirstRows[0]?.alignmentJson).toBeNull();
    await fixture.model.readSegmentState(session, 0);
    await fixture.model.readSegmentState(session, 0);
    expect(fixture.readSegmentMetadata).toHaveBeenCalledTimes(1);

    fixture.sidecars.set(0, completedSidecar(0));
    const exactRows = await fixture.model.readSegmentIndexRows(session, { minOrdinal: 0, limit: 1 });
    expect(exactRows[0]?.alignmentSource).toBe('exact');
    const exact = JSON.parse(exactRows[0]?.alignmentJson ?? 'null') as {
      words?: Array<{ text?: string; endSec?: number }>;
    } | null;
    expect(exact?.words).toEqual([expect.objectContaining({ text: 'Segment', endSec: 0.5 })]);
    expect(fixture.readSegmentMetadata).toHaveBeenCalledTimes(2);
  });

  test('bounds sidecar reads to the requested ordinal window', async () => {
    const fixture = createFixture();
    fixture.sidecars.set(41, completedSidecar(41));

    await expect(fixture.model.readSegmentIndexRows(session, {
      minOrdinal: 40,
      limit: 3,
    })).resolves.toMatchObject([{ ordinal: 41 }]);

    expect(fixture.readSegmentMetadata).toHaveBeenCalledTimes(3);
    expect(fixture.readSegmentMetadata.mock.calls.map(([scope]) => scope.ordinal)).toEqual([40, 41, 42]);
  });

  test('keeps all cached chapters visible without probing absent ordinals', async () => {
    const fixture = createFixture();
    fixture.sidecars.set(2, completedSidecar(2));
    fixture.sidecars.set(80, completedSidecar(80));

    const nearStartSession = { ...session, cursorOrdinal: 0 };
    await expect(fixture.model.readSegmentIndexRows(nearStartSession))
      .resolves.toMatchObject([{ ordinal: 2 }, { ordinal: 80 }]);
    expect(fixture.readSegmentMetadata.mock.calls.map(([scope]) => scope.ordinal))
      .toEqual([2, 80]);

    // Moving back retains both cached regions without refetching exact timing.
    await expect(fixture.model.readSegmentState(session, 80))
      .resolves.toMatchObject({ status: 'completed', ordinal: 80 });
    fixture.readSegmentMetadata.mockClear();
    await expect(fixture.model.readSegmentIndexRows(nearStartSession))
      .resolves.toMatchObject([{ ordinal: 2 }, { ordinal: 80 }]);
    expect(fixture.readSegmentMetadata).not.toHaveBeenCalled();
  });

  test('shares slow catalogue reads and discovers exact timing in a sparsely generated long book', async () => {
    const fixture = createFixture(10_000);
    const deepSession = { ...session, cursorOrdinal: 9_000 };
    fixture.sidecars.set(2, completedSidecar(2));
    fixture.sidecars.set(9_000, { ...completedSidecar(9_000), alignment: null });
    let release!: (ordinals: number[]) => void;
    const listed = new Promise<number[]>((resolve) => { release = resolve; });
    fixture.listSegmentOrdinals.mockReturnValueOnce(listed);
    const timeline = fixture.model.readSegmentIndexRows(deepSession);
    const overview = fixture.model.readSegmentIndexRows(deepSession);
    await vi.waitFor(() => expect(fixture.listSegmentOrdinals).toHaveBeenCalledTimes(1));
    release([2, 9_000]);
    expect((await timeline).map((row) => row.alignmentSource)).toEqual(['exact', null]);
    expect((await overview).map((row) => row.ordinal)).toEqual([2, 9_000]);
    expect(fixture.readSegmentMetadata).toHaveBeenCalledTimes(2);

    fixture.sidecars.set(9_000, completedSidecar(9_000));
    // Whole-book overviews retain audio-only metadata instead of refetching
    // thousands of entries outside the playhead. The priority window heals
    // alignment as soon as playback visits that ordinal.
    const overviewAgain = await fixture.model.readSegmentIndexRows(deepSession);
    expect(overviewAgain.at(-1)?.alignmentSource).toBe(null);
    expect(fixture.readSegmentMetadata).toHaveBeenCalledTimes(2);
    const exact = await fixture.model.readSegmentIndexRows(deepSession, { minOrdinal: 9000, limit: 1 });
    expect(exact.at(-1)?.alignmentSource).toBe('exact');
    expect(fixture.readSegmentMetadata).toHaveBeenCalledTimes(3);
  });

  test('reads a deep cursor window while the whole-book catalogue remains blocked', async () => {
    const fixture = createFixture(10_000);
    fixture.sidecars.set(8000, completedSidecar(8000));
    fixture.listSegmentOrdinals.mockImplementation(() => new Promise<number[]>(() => undefined));
    const rows = await fixture.model.readSegmentIndexRows(session, { minOrdinal: 8000, limit: 64 });
    expect(rows.map((row) => row.ordinal)).toEqual([8000]);
    expect(fixture.listSegmentOrdinals).not.toHaveBeenCalled();
    expect(fixture.readSegmentMetadata).toHaveBeenCalledTimes(64);
    expect(fixture.readSegmentMetadata.mock.calls.every(([scope]) => scope.ordinal >= 8000 && scope.ordinal < 8064)).toBe(true);
  });

  test('serves the in-process sidecar cache when catalogue discovery fails', async () => {
    const fixture = createFixture();
    fixture.sidecars.set(2, completedSidecar(2));
    await expect(fixture.model.readSegmentState(session, 2))
      .resolves.toMatchObject({ status: 'completed', ordinal: 2 });
    fixture.listSegmentOrdinals.mockRejectedValueOnce(new Error('catalogue unavailable'));
    await expect(fixture.model.readSegmentIndexRows(session))
      .resolves.toMatchObject([{ ordinal: 2 }]);
  });

  test('does not reuse a pending scope collection after cache invalidation', async () => {
    const fixture = createFixture();
    fixture.sidecars.set(0, completedSidecar(0));
    let release!: (ordinals: number[]) => void;
    fixture.listSegmentOrdinals.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const staleRead = fixture.model.readSegmentIndexRows(session);
    await vi.waitFor(() => expect(fixture.listSegmentOrdinals).toHaveBeenCalledTimes(1));

    fixture.sidecars.clear();
    fixture.sidecars.set(1, completedSidecar(1));
    expect(fixture.model.invalidateSidecarsForScope({
      storageUserId: session.storageUserId,
      documentId: session.documentId,
      documentVersion: session.documentVersion,
      settingsHash: session.settingsHash,
    })).toBe(1);

    await expect(fixture.model.readSegmentIndexRows(session))
      .resolves.toMatchObject([{ ordinal: 1 }]);
    expect(fixture.listSegmentOrdinals).toHaveBeenCalledTimes(2);
    release([0]);
    await staleRead;
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

    await expect(fixture.model.readPlanSegments(session.planObjectKey!)).resolves.toHaveLength(100);
    fixture.objects.set(session.planObjectKey!, Buffer.from(JSON.stringify({ segments: [{ ordinal: 1, text: 'New.' }] })));
    await expect(fixture.model.readPlanSegments(session.planObjectKey!)).resolves.toHaveLength(100);
    expect(fixture.model.invalidatePlansUnderPrefix('openreader/plans/')).toBe(1);
    await expect(fixture.model.readPlanSegments(session.planObjectKey!)).resolves.toMatchObject([{ ordinal: 1 }]);
  });
});

import { createHash } from 'node:crypto';
import type { TTSSentenceAlignment } from '../operations/contracts';
import type { ArtifactStorage } from '../infrastructure/storage';
import { createJsonCodec } from '../infrastructure/json-codec';
import type { KvStoreLike } from '../infrastructure/nats-adapters';
import { ttsPlaybackSegmentSidecarArtifactKey } from '../storage/artifact-addressing';

export type TtsPlaybackSessionStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type TtsPlaybackSegmentStatus = 'generating' | 'completed' | 'error';

export interface TtsPlaybackSessionState {
  schemaVersion: 1;
  sessionId: string;
  userId: string;
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  readerType: 'pdf' | 'epub' | 'html';
  status: TtsPlaybackSessionStatus;
  workerOpId?: string | null;
  settingsHash: string;
  settingsJson: unknown;
  aheadWindow?: number | null;
  backgroundExtent?: 'section' | 'document' | null;
  generationExtent?: 'window' | 'document' | null;
  planning?: unknown;
  generationStartOrdinal: number;
  cursorOrdinal: number;
  cursorUpdatedAt: number | null;
  planObjectKey: string | null;
  expiresAt: number;
  lastError: string | null;
  updatedAt: number;
}

export interface TtsPlaybackSegmentMetadata {
  schemaVersion: 1;
  cacheEpoch?: number;
  status: TtsPlaybackSegmentStatus;
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  readerType: 'pdf' | 'epub' | 'html';
  settingsHash: string;
  settingsJson?: unknown;
  ordinal: number;
  segmentKey: string | null;
  textHash: string;
  textLength: number;
  audioKey: string;
  audioFormat: 'mp3';
  durationMs: number | null;
  alignment: TTSSentenceAlignment | null;
  error: unknown | null;
  leaseOwnerId?: string | null;
  leaseUpdatedAt?: number | null;
  updatedAt: number;
}

/** Scope identifying one (user, document version, settings) namespace of sidecars. */
export interface TtsPlaybackSegmentScope {
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  settingsHash: string;
}

export interface TtsPlaybackResetScope {
  storageUserId: string;
  documentId: string;
  documentVersion?: number;
  settingsHash?: string;
}

export interface TtsPlaybackSessionStore {
  getSession(sessionId: string): Promise<TtsPlaybackSessionState | null>;
  putSession(state: TtsPlaybackSessionState): Promise<void>;
  patchSession(sessionId: string, patch: Partial<Omit<TtsPlaybackSessionState, 'schemaVersion' | 'sessionId'>>): Promise<void>;
  updateCursor(sessionId: string, ordinal: number, updatedAt?: number): Promise<void>;
  listSessions(scope?: TtsPlaybackResetScope): Promise<TtsPlaybackSessionState[]>;
  cancelSessionsForScope(scope: TtsPlaybackResetScope, updatedAt?: number): Promise<number>;
}

export interface TtsPlaybackSegmentArtifactStore {
  /** S3 key of one segment's sidecar, addressable directly from the plan ordinal. */
  sidecarKey(input: TtsPlaybackSegmentScope & { ordinal: number }): string;
  /** Write one segment's sidecar (plain put to its own key — race-free). */
  putSegmentMetadata(metadata: TtsPlaybackSegmentMetadata): Promise<string>;
  /** Read one segment's sidecar by ordinal. Returns null when not yet generated. */
  readSegmentMetadata(
    input: TtsPlaybackSegmentScope & { ordinal: number },
  ): Promise<TtsPlaybackSegmentMetadata | null>;
  getScopeEpoch(scope: TtsPlaybackResetScope): Promise<number>;
  incrementScopeEpoch(scope: TtsPlaybackResetScope, updatedAt?: number): Promise<number>;
}

export interface TtsPlaybackStorage {
  sessions: TtsPlaybackSessionStore;
  artifacts: TtsPlaybackSegmentArtifactStore;
}

type KvEntry = Awaited<ReturnType<KvStoreLike['get']>>;

function hashScope(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isKvPut(entry: KvEntry): entry is NonNullable<KvEntry> {
  return Boolean(entry && (!entry.operation || entry.operation === 'PUT'));
}

function sessionKvKey(sessionId: string): string {
  return `tts_playback.session.${hashScope(sessionId)}`;
}

// The cursor (playhead) lives on its OWN key, separate from the worker-owned
// session record. It is written with a plain last-write-wins `put` — never CAS —
// because the per-second heartbeat from the client and the audio stream must not
// contend with the worker's status writes. Splitting the key is what removes the
// `wrong last sequence` failures; see PLAYBACK_ARCHITECTURE.md ("the golden rule").
function cursorKvKey(sessionId: string): string {
  return `tts_playback.cursor.${hashScope(sessionId)}`;
}

function epochKvKey(scope: TtsPlaybackResetScope & { settingsHash?: string }): string {
  const version = typeof scope.documentVersion === 'number' && Number.isFinite(scope.documentVersion)
    ? Math.max(0, Math.floor(scope.documentVersion))
    : '*';
  const settingsHash = scope.settingsHash?.trim() || '*';
  return `tts_playback.cache_epoch.${hashScope([
    scope.storageUserId,
    scope.documentId,
    String(version),
    settingsHash,
  ].join('\0'))}`;
}

function sessionMatchesScope(session: TtsPlaybackSessionState, scope: TtsPlaybackResetScope): boolean {
  return session.storageUserId === scope.storageUserId
    && session.documentId === scope.documentId
    && (scope.documentVersion === undefined || session.documentVersion === Math.max(0, Math.floor(scope.documentVersion)))
    && (scope.settingsHash === undefined || session.settingsHash === scope.settingsHash);
}

function isResettableSessionStatus(status: TtsPlaybackSessionStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'succeeded';
}

interface TtsPlaybackCursorRecord {
  cursorOrdinal: number;
  cursorUpdatedAt: number | null;
}

interface TtsPlaybackCacheEpochRecord {
  cacheEpoch: number;
  updatedAt: number;
}

export function createTtsPlaybackKvStore(input: {
  getKv: () => Promise<KvStoreLike>;
}): TtsPlaybackSessionStore {
  const sessionCodec = createJsonCodec<TtsPlaybackSessionState>();
  const cursorCodec = createJsonCodec<TtsPlaybackCursorRecord>();
  const listSessions = async (scope?: TtsPlaybackResetScope): Promise<TtsPlaybackSessionState[]> => {
    const kv = await input.getKv();
    const keys = await kv.keys('tts_playback.session.*');
    const sessions: TtsPlaybackSessionState[] = [];
    for await (const key of keys) {
      const entry = await kv.get(key);
      if (!isKvPut(entry)) continue;
      const session = sessionCodec.decode(entry.value);
      if (scope && !sessionMatchesScope(session, scope)) continue;
      const cursorEntry = await kv.get(cursorKvKey(session.sessionId));
      if (isKvPut(cursorEntry)) {
        const cursor = cursorCodec.decode(cursorEntry.value);
        session.cursorOrdinal = cursor.cursorOrdinal;
        session.cursorUpdatedAt = cursor.cursorUpdatedAt;
      }
      sessions.push(session);
    }
    return sessions;
  };

  return {
    async getSession(sessionId) {
      const kv = await input.getKv();
      const entry = await kv.get(sessionKvKey(sessionId));
      if (!isKvPut(entry)) return null;
      const session = sessionCodec.decode(entry.value);
      // The cursor is authoritative on its own key; overlay it on top of the
      // record's last-known snapshot so callers see the live playhead.
      const cursorEntry = await kv.get(cursorKvKey(sessionId));
      if (isKvPut(cursorEntry)) {
        const cursor = cursorCodec.decode(cursorEntry.value);
        session.cursorOrdinal = cursor.cursorOrdinal;
        session.cursorUpdatedAt = cursor.cursorUpdatedAt;
      }
      return session;
    },

    async putSession(state) {
      const kv = await input.getKv();
      await kv.put(sessionKvKey(state.sessionId), sessionCodec.encode(state));
      await kv.put(cursorKvKey(state.sessionId), cursorCodec.encode({
        cursorOrdinal: Math.max(0, Math.floor(state.cursorOrdinal)),
        cursorUpdatedAt: state.cursorUpdatedAt,
      }));
    },

    async patchSession(sessionId, patch) {
      const kv = await input.getKv();
      // Cursor fields go to the cursor key — never the record — so this write
      // never collides with the playhead heartbeat. Plain put, last-write-wins.
      if (patch.cursorOrdinal !== undefined && patch.cursorUpdatedAt !== undefined) {
        await kv.put(cursorKvKey(sessionId), cursorCodec.encode({
          cursorOrdinal: Math.max(0, Math.floor(patch.cursorOrdinal)),
          cursorUpdatedAt: patch.cursorUpdatedAt,
        }));
      }
      const recordPatch: Partial<TtsPlaybackSessionState> = { ...patch };
      delete recordPatch.cursorOrdinal;
      delete recordPatch.cursorUpdatedAt;
      // A bare `updatedAt` bump (the per-second cursor POST) doesn't justify
      // rewriting the record — the cursor key already carries a fresh timestamp.
      const meaningful = Object.keys(recordPatch).filter((field) => field !== 'updatedAt');
      if (meaningful.length === 0) return;
      const key = sessionKvKey(sessionId);
      const entry = await kv.get(key);
      if (!isKvPut(entry)) return;
      const current = sessionCodec.decode(entry.value);
      const next: TtsPlaybackSessionState = {
        ...current,
        ...recordPatch,
        sessionId: current.sessionId,
        schemaVersion: 1,
        updatedAt: recordPatch.updatedAt ?? Date.now(),
      };
      await kv.put(key, sessionCodec.encode(next));
    },

    async updateCursor(sessionId, ordinal, updatedAt = Date.now()) {
      const kv = await input.getKv();
      // Pure last-write-wins put on the cursor's own key. No read, no CAS: a
      // racing writer simply means newest-wins, the correct "where am I now"
      // semantics for a playhead hint.
      await kv.put(cursorKvKey(sessionId), cursorCodec.encode({
        cursorOrdinal: Math.max(0, Math.floor(ordinal)),
        cursorUpdatedAt: updatedAt,
      }));
    },

    async listSessions(scope) {
      return listSessions(scope);
    },

    async cancelSessionsForScope(scope, updatedAt = Date.now()) {
      const sessions = await listSessions(scope);
      let canceled = 0;
      for (const session of sessions) {
        if (!isResettableSessionStatus(session.status)) continue;
        await this.patchSession(session.sessionId, {
          status: 'canceled',
          lastError: 'Playback cache was cleared',
          updatedAt,
        });
        canceled += 1;
      }
      return canceled;
    },
  };
}

export function createTtsPlaybackSegmentArtifactStore(input: {
  storage: ArtifactStorage;
  s3Prefix: string;
  getKv?: () => Promise<KvStoreLike>;
}): TtsPlaybackSegmentArtifactStore {
  const epochCodec = createJsonCodec<TtsPlaybackCacheEpochRecord>();
  const metadataFromBytes = (bytes: ArrayBuffer, expectedOrdinal: number): TtsPlaybackSegmentMetadata => {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as TtsPlaybackSegmentMetadata;
    if (parsed.schemaVersion !== 1) {
      throw new Error(`Unsupported TTS playback segment sidecar schema version: ${String(parsed.schemaVersion)}`);
    }
    if (Math.max(0, Math.floor(Number(parsed.ordinal))) !== Math.max(0, Math.floor(expectedOrdinal))) {
      throw new Error('TTS playback segment sidecar ordinal does not match object key');
    }
    return parsed;
  };
  const sidecarKey = (scope: TtsPlaybackSegmentScope & { ordinal: number }) =>
    ttsPlaybackSegmentSidecarArtifactKey({
      storageUserHash: hashScope(scope.storageUserId),
      documentId: scope.documentId,
      documentVersion: scope.documentVersion,
      settingsHash: scope.settingsHash,
      ordinal: scope.ordinal,
      prefix: input.s3Prefix,
    });

  return {
    sidecarKey,

    async putSegmentMetadata(metadata) {
      // One segment → one immutable object at its own key. Plain put, no shared
      // aggregate to read-merge-write, so there is no lost-update race and
      // concurrent workers stay correct.
      const key = sidecarKey(metadata);
      await input.storage.putObject(
        key,
        Buffer.from(JSON.stringify(metadata)),
        'application/json',
      );
      return key;
    },

    async readSegmentMetadata(scope) {
      try {
        return metadataFromBytes(await input.storage.readObject(sidecarKey(scope)), scope.ordinal);
      } catch {
        return null;
      }
    },

    async getScopeEpoch(scope) {
      if (!input.getKv) return 0;
      const kv = await input.getKv();
      const keys = [
        epochKvKey({ ...scope, documentVersion: undefined, settingsHash: undefined }),
        ...(scope.settingsHash ? [epochKvKey({ ...scope, documentVersion: undefined })] : []),
        ...(scope.documentVersion === undefined ? [] : [epochKvKey({ ...scope, settingsHash: undefined })]),
        ...(scope.documentVersion !== undefined && scope.settingsHash ? [epochKvKey(scope)] : []),
      ];
      let epoch = 0;
      for (const key of keys) {
        const entry = await kv.get(key);
        if (!isKvPut(entry)) continue;
        const record = epochCodec.decode(entry.value);
        epoch = Math.max(epoch, Math.max(0, Math.floor(record.cacheEpoch)));
      }
      return epoch;
    },

    async incrementScopeEpoch(scope, updatedAt = Date.now()) {
      if (!input.getKv) return 0;
      const kv = await input.getKv();
      const key = epochKvKey(scope);
      const currentEntry = await kv.get(key);
      const current = isKvPut(currentEntry)
        ? Math.max(0, Math.floor(epochCodec.decode(currentEntry.value).cacheEpoch))
        : 0;
      const next = current + 1;
      await kv.put(key, epochCodec.encode({ cacheEpoch: next, updatedAt }));
      return next;
    },
  };
}

export function createTtsPlaybackStorage(input: {
  getKv: () => Promise<KvStoreLike>;
  storage: ArtifactStorage;
  s3Prefix: string;
}): TtsPlaybackStorage {
  return {
    sessions: createTtsPlaybackKvStore({ getKv: input.getKv }),
    artifacts: createTtsPlaybackSegmentArtifactStore({
      getKv: input.getKv,
      storage: input.storage,
      s3Prefix: input.s3Prefix,
    }),
  };
}

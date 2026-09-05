import { createHash } from 'node:crypto';
import type { TTSSentenceAlignment } from '../operations/contracts';
import type { ArtifactStorage } from '../infrastructure/storage';
import { createJsonCodec } from '../infrastructure/json-codec';
import { isKvCasConflictError, type KvStoreLike } from '../infrastructure/nats-adapters';
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
  /** Whether the live client currently wants generation to continue. */
  playbackActive?: boolean;
  /** Identifies the generation run that currently owns this canonical session. */
  generationRunId?: string | null;
  /** Stable identity for one canonical-session incarnation; unlike expiresAt it never rolls. */
  sessionInstanceId?: string;
  generationSatisfiedFromOrdinal?: number | null;
  generationSatisfiedThroughOrdinal?: number | null;
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
  putSessionIfNewer(state: TtsPlaybackSessionState): Promise<boolean>;
  patchSession(sessionId: string, patch: Partial<Omit<TtsPlaybackSessionState, 'schemaVersion' | 'sessionId'>>, expectedSessionInstanceId?: string): Promise<void>;
  patchSessionIfGenerationRun(
    sessionId: string,
    expectedGenerationRunId: string | null,
    patch: Partial<Omit<TtsPlaybackSessionState, 'schemaVersion' | 'sessionId'>>,
  ): Promise<boolean>;
  updateCursor(
    sessionId: string,
    ordinal: number,
    expectedSessionInstanceId: string,
    updatedAt?: number,
  ): Promise<boolean>;
  watchGenerationInvalidation(
    sessionId: string,
    expectedGenerationRunId: string | null,
    onInvalidated: () => void,
  ): Promise<() => void>;
  listSessions(scope?: TtsPlaybackResetScope): Promise<TtsPlaybackSessionState[]>;
  cancelSessionsForScope(scope: TtsPlaybackResetScope, updatedAt?: number): Promise<number>;
}

export interface TtsPlaybackSegmentArtifactStore {
  /** S3 key of one segment's sidecar, addressable directly from the plan ordinal. */
  sidecarKey(input: TtsPlaybackSegmentScope & { ordinal: number }): string;
  /** Discover stored ordinals without issuing an object-store miss for every ungenerated segment. */
  listSegmentOrdinals(scope: TtsPlaybackSegmentScope): Promise<number[]>;
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

// Explicit play/pause intent is client-owned hot state like the cursor, but it
// has its own key so an audio-stream cursor update cannot race with and revive
// a paused session. Plain put gives the latest user intent last-write-wins
// semantics without contending with worker status writes.
function activityKvKey(sessionId: string): string {
  return `tts_playback.activity.${hashScope(sessionId)}`;
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
  sessionInstanceId?: string;
  sessionExpiresAt?: number;
  cursorOrdinal: number;
  cursorUpdatedAt: number | null;
}

interface TtsPlaybackCacheEpochRecord {
  cacheEpoch: number;
  updatedAt: number;
}

interface TtsPlaybackActivityRecord {
  sessionInstanceId?: string;
  sessionExpiresAt?: number;
  playbackActive: boolean;
  updatedAt: number;
}

export function resolveTtsPlaybackSessionInstanceId(session: TtsPlaybackSessionState): string {
  return session.sessionInstanceId
    ?? `legacy:${session.expiresAt}:${session.generationRunId ?? 'initial'}`;
}

function sidecarMatchesSession(
  sidecar: { sessionInstanceId?: string; sessionExpiresAt?: number },
  session: TtsPlaybackSessionState,
): boolean {
  if (sidecar.sessionInstanceId) {
    return sidecar.sessionInstanceId === resolveTtsPlaybackSessionInstanceId(session);
  }
  return sidecar.sessionExpiresAt === undefined || sidecar.sessionExpiresAt === session.expiresAt;
}

export function createTtsPlaybackKvStore(input: {
  getKv: () => Promise<KvStoreLike>;
}): TtsPlaybackSessionStore {
  const sessionCodec = createJsonCodec<TtsPlaybackSessionState>();
  const cursorCodec = createJsonCodec<TtsPlaybackCursorRecord>();
  const activityCodec = createJsonCodec<TtsPlaybackActivityRecord>();
  const patchSessionRecord = async (
    sessionId: string,
    recordPatch: Partial<TtsPlaybackSessionState>,
    expectedGenerationRunId?: string | null,
    expectedSessionInstanceId?: string,
  ): Promise<boolean> => {
    const kv = await input.getKv();
    const key = sessionKvKey(sessionId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const entry = await kv.get(key);
      if (!isKvPut(entry)) return false;
      const current = sessionCodec.decode(entry.value);
      if (expectedSessionInstanceId !== undefined
        && resolveTtsPlaybackSessionInstanceId(current) !== expectedSessionInstanceId) return false;
      if (
        expectedGenerationRunId !== undefined
        && (current.generationRunId ?? null) !== expectedGenerationRunId
      ) return false;
      const next: TtsPlaybackSessionState = {
        ...current,
        ...recordPatch,
        sessionId: current.sessionId,
        schemaVersion: 1,
        updatedAt: recordPatch.updatedAt ?? Date.now(),
      };
      try {
        await kv.update(key, sessionCodec.encode(next), entry.revision);
        return true;
      } catch (error) {
        if (!isKvCasConflictError(error)) throw error;
      }
    }
    throw new Error(`Unable to update playback session ${sessionId} after repeated conflicts`);
  };
  const listSessions = async (scope?: TtsPlaybackResetScope): Promise<TtsPlaybackSessionState[]> => {
    const kv = await input.getKv();
    const keys: string[] = [];
    for await (const key of await kv.keys('tts_playback.session.*')) keys.push(key);
    const sessions: TtsPlaybackSessionState[] = [];
    for (let index = 0; index < keys.length; index += 32) {
      const entries = await Promise.all(keys.slice(index, index + 32).map((key) => kv.get(key)));
      for (const entry of entries) {
        if (!isKvPut(entry)) continue;
        const session = sessionCodec.decode(entry.value);
        session.sessionInstanceId = resolveTtsPlaybackSessionInstanceId(session);
        if (scope && !sessionMatchesScope(session, scope)) continue;
        sessions.push(session);
      }
    }
    for (let index = 0; index < sessions.length; index += 32) {
      await Promise.all(sessions.slice(index, index + 32).map(async (session) => {
        const cursorEntry = await kv.get(cursorKvKey(session.sessionId));
        if (isKvPut(cursorEntry)) {
          const cursor = cursorCodec.decode(cursorEntry.value);
          if (sidecarMatchesSession(cursor, session)) {
            session.cursorOrdinal = cursor.cursorOrdinal;
            session.cursorUpdatedAt = cursor.cursorUpdatedAt;
          }
        }
        const activityEntry = await kv.get(activityKvKey(session.sessionId));
        if (isKvPut(activityEntry)) {
          const activity = activityCodec.decode(activityEntry.value);
          if (sidecarMatchesSession(activity, session)) {
            session.playbackActive = activity.playbackActive;
          }
        }
      }));
    }
    return sessions;
  };

  return {
    async getSession(sessionId) {
      const kv = await input.getKv();
      const entry = await kv.get(sessionKvKey(sessionId));
      if (!isKvPut(entry)) return null;
      const session = sessionCodec.decode(entry.value);
      session.sessionInstanceId = resolveTtsPlaybackSessionInstanceId(session);
      // The cursor is authoritative on its own key; overlay it on top of the
      // record's last-known snapshot so callers see the live playhead.
      const cursorEntry = await kv.get(cursorKvKey(sessionId));
      if (isKvPut(cursorEntry)) {
        const cursor = cursorCodec.decode(cursorEntry.value);
        if (sidecarMatchesSession(cursor, session)) {
          session.cursorOrdinal = cursor.cursorOrdinal;
          session.cursorUpdatedAt = cursor.cursorUpdatedAt;
        }
      }
      const activityEntry = await kv.get(activityKvKey(sessionId));
      if (isKvPut(activityEntry)) {
        const activity = activityCodec.decode(activityEntry.value);
        if (sidecarMatchesSession(activity, session)) {
          session.playbackActive = activity.playbackActive;
        }
      }
      return session;
    },

    async putSessionIfNewer(state) {
      const kv = await input.getKv();
      const key = sessionKvKey(state.sessionId);
      const nextState: TtsPlaybackSessionState = {
        ...state,
        sessionInstanceId: resolveTtsPlaybackSessionInstanceId(state),
      };
      let accepted = false;
      // The canonical session id is reused across starts. The Next control
      // plane assigns later starts a later expiry, giving overlapping requests
      // a stable ordering that does not depend on worker arrival order.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const entry = await kv.get(key);
        if (isKvPut(entry)) {
          const current = sessionCodec.decode(entry.value);
          if (nextState.expiresAt <= current.expiresAt) {
            return (nextState.generationRunId ?? null) === (current.generationRunId ?? null);
          }
          try {
            await kv.update(key, sessionCodec.encode(nextState), entry.revision);
            accepted = true;
            break;
          } catch (error) {
            if (!isKvCasConflictError(error)) throw error;
            continue;
          }
        }
        try {
          await kv.create(key, sessionCodec.encode(nextState));
          accepted = true;
          break;
        } catch (error) {
          if (!isKvCasConflictError(error)) throw error;
        }
      }
      if (!accepted) throw new Error(`Unable to create playback session ${state.sessionId} after repeated conflicts`);
      await kv.put(cursorKvKey(state.sessionId), cursorCodec.encode({
        sessionInstanceId: nextState.sessionInstanceId,
        sessionExpiresAt: state.expiresAt,
        cursorOrdinal: Math.max(0, Math.floor(state.cursorOrdinal)),
        cursorUpdatedAt: state.cursorUpdatedAt,
      }));
      await kv.put(activityKvKey(state.sessionId), activityCodec.encode({
        sessionInstanceId: nextState.sessionInstanceId,
        sessionExpiresAt: state.expiresAt,
        playbackActive: state.playbackActive !== false,
        updatedAt: state.updatedAt,
      }));
      return true;
    },

    async patchSession(sessionId, patch, expectedSessionInstanceId) {
      const kv = await input.getKv();
      const sessionEntry = await kv.get(sessionKvKey(sessionId));
      if (!isKvPut(sessionEntry)) return;
      const currentSession = sessionCodec.decode(sessionEntry.value);
      const sessionInstanceId = resolveTtsPlaybackSessionInstanceId(currentSession);
      if (expectedSessionInstanceId !== undefined && sessionInstanceId !== expectedSessionInstanceId) return;
      if (patch.playbackActive !== undefined) {
        await kv.put(activityKvKey(sessionId), activityCodec.encode({
          sessionInstanceId,
          sessionExpiresAt: currentSession.expiresAt,
          playbackActive: patch.playbackActive,
          updatedAt: patch.updatedAt ?? Date.now(),
        }));
      }
      // Cursor fields go to the cursor key — never the record — so this write
      // never collides with the playhead heartbeat. Plain put, last-write-wins.
      if (patch.cursorOrdinal !== undefined && patch.cursorUpdatedAt !== undefined) {
        await kv.put(cursorKvKey(sessionId), cursorCodec.encode({
          sessionInstanceId,
          sessionExpiresAt: currentSession.expiresAt,
          cursorOrdinal: Math.max(0, Math.floor(patch.cursorOrdinal)),
          cursorUpdatedAt: patch.cursorUpdatedAt,
        }));
      }
      const recordPatch: Partial<TtsPlaybackSessionState> = { ...patch };
      delete recordPatch.cursorOrdinal;
      delete recordPatch.cursorUpdatedAt;
      delete recordPatch.playbackActive;
      if (!currentSession.sessionInstanceId) recordPatch.sessionInstanceId = sessionInstanceId;
      // A bare `updatedAt` bump (the per-second cursor POST) doesn't justify
      // rewriting the record — the cursor key already carries a fresh timestamp.
      const meaningful = Object.keys(recordPatch).filter((field) => field !== 'updatedAt');
      if (meaningful.length === 0) return;
      await patchSessionRecord(sessionId, recordPatch, undefined, sessionInstanceId);
    },

    async patchSessionIfGenerationRun(sessionId, expectedGenerationRunId, patch) {
      const recordPatch: Partial<TtsPlaybackSessionState> = { ...patch };
      delete recordPatch.cursorOrdinal;
      delete recordPatch.cursorUpdatedAt;
      delete recordPatch.playbackActive;
      return patchSessionRecord(sessionId, recordPatch, expectedGenerationRunId);
    },

    async updateCursor(sessionId, ordinal, expectedSessionInstanceId, updatedAt = Date.now()) {
      const kv = await input.getKv();
      const sessionEntry = await kv.get(sessionKvKey(sessionId));
      if (!isKvPut(sessionEntry)) return false;
      const session = sessionCodec.decode(sessionEntry.value);
      if (resolveTtsPlaybackSessionInstanceId(session) !== expectedSessionInstanceId) return false;
      // Pure last-write-wins put on the cursor's own key. There is no CAS or
      // shared session rewrite. Stamp the captured instance id, rather than
      // re-reading it after the request begins, so a replacement racing this
      // put can only leave a sidecar that the successor ignores.
      await kv.put(cursorKvKey(sessionId), cursorCodec.encode({
        sessionInstanceId: expectedSessionInstanceId,
        sessionExpiresAt: session.expiresAt,
        cursorOrdinal: Math.max(0, Math.floor(ordinal)),
        cursorUpdatedAt: updatedAt,
      }));
      return true;
    },

    async watchGenerationInvalidation(sessionId, expectedGenerationRunId, onInvalidated) {
      const kv = await input.getKv();
      if (!kv.watch) return () => undefined;
      const watcher = await kv.watch({
        key: [sessionKvKey(sessionId), activityKvKey(sessionId)],
        include: 'updates',
      });
      let stopped = false;
      let expiryTimer: ReturnType<typeof setTimeout> | null = null;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (expiryTimer !== null) {
          clearTimeout(expiryTimer);
          expiryTimer = null;
        }
        watcher.stop();
      };
      const invalidate = () => {
        if (stopped) return;
        onInvalidated();
        stop();
      };
      const scheduleExpiryInvalidation = (expiresAt: number) => {
        if (expiryTimer !== null) clearTimeout(expiryTimer);
        const delayMs = Math.max(0, expiresAt - Date.now());
        expiryTimer = setTimeout(() => {
          expiryTimer = null;
          if (Date.now() >= expiresAt) invalidate();
          else scheduleExpiryInvalidation(expiresAt);
        }, Math.min(delayMs, 2_147_483_647));
      };
      const current = await this.getSession(sessionId);
      if (
        !current
        || (current.status !== 'queued' && current.status !== 'running')
        || (current.generationRunId ?? null) !== expectedGenerationRunId
        || current.playbackActive === false
        || Date.now() > current.expiresAt
      ) {
        invalidate();
        return stop;
      }
      const expectedSessionInstanceId = resolveTtsPlaybackSessionInstanceId(current);
      scheduleExpiryInvalidation(current.expiresAt);
      void (async () => {
        try {
          for await (const entry of watcher) {
            if (stopped || entry.operation !== 'PUT') continue;
            if (entry.key === sessionKvKey(sessionId)) {
              const session = sessionCodec.decode(entry.value);
              if (
                resolveTtsPlaybackSessionInstanceId(session) !== expectedSessionInstanceId
                || (session.status !== 'queued' && session.status !== 'running')
                || (session.generationRunId ?? null) !== expectedGenerationRunId
                || Date.now() > session.expiresAt
              ) {
                invalidate();
              } else {
                scheduleExpiryInvalidation(session.expiresAt);
              }
              continue;
            }
            if (entry.key === activityKvKey(sessionId)) {
              const activity = activityCodec.decode(entry.value);
              if (
                sidecarMatchesSession(activity, current)
                && activity.playbackActive === false
              ) {
                invalidate();
              }
            }
          }
        } catch {
          // Boundary checks remain the fallback if a NATS watch is interrupted.
        }
      })();
      return stop;
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

    async listSegmentOrdinals(scope) {
      const prefix = sidecarKey({ ...scope, ordinal: 0 }).slice(0, -'0.json'.length);
      const keys = await input.storage.listPrefix(prefix);
      return [...new Set(keys.flatMap((key) => {
        if (!key.startsWith(prefix)) return [];
        const match = /^(\d+)\.json$/.exec(key.slice(prefix.length));
        const ordinal = match ? Number(match[1]) : NaN;
        return Number.isSafeInteger(ordinal) ? [ordinal] : [];
      }))].sort((a, b) => a - b);
    },

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

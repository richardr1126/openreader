import { createHash } from 'node:crypto';
import type { TTSSentenceAlignment } from '../operations/contracts';
import type { ArtifactStorage } from '../infrastructure/storage';
import { createJsonCodec } from '../infrastructure/json-codec';
import type { KvStoreLike } from '../infrastructure/nats-adapters';
import {
  ttsPlaybackSegmentIndexArtifactKey,
  ttsPlaybackSegmentMetadataArtifactKey,
} from '../storage/artifact-addressing';

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
  status: TtsPlaybackSegmentStatus;
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  readerType: 'pdf' | 'epub' | 'html';
  settingsHash: string;
  settingsJson?: unknown;
  segmentId: string;
  segmentEntryId: string;
  segmentIndex: number;
  segmentKey: string | null;
  textHash: string;
  textLength: number;
  audioKey: string;
  audioFormat: 'mp3';
  durationMs: number | null;
  alignment: TTSSentenceAlignment | null;
  error: unknown | null;
  updatedAt: number;
}

export interface TtsPlaybackSegmentIndexEntry {
  segmentIndex: number;
  segmentId: string;
  segmentKey: string | null;
  metadataKey: string;
  audioKey: string;
  durationMs: number | null;
  status: TtsPlaybackSegmentStatus;
  updatedAt: number;
}

export interface TtsPlaybackSegmentIndexArtifact {
  schemaVersion: 1;
  storageUserHash: string;
  documentId: string;
  documentVersion: number;
  settingsHash: string;
  updatedAt: number;
  segments: TtsPlaybackSegmentIndexEntry[];
}

export interface TtsPlaybackSegmentClaim {
  schemaVersion: 1;
  status: TtsPlaybackSegmentStatus;
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  settingsHash: string;
  segmentId: string;
  audioKey: string;
  updatedAt: number;
  ownerId: string | null;
}

export interface TtsPlaybackSessionStore {
  getSession(sessionId: string): Promise<TtsPlaybackSessionState | null>;
  putSession(state: TtsPlaybackSessionState): Promise<void>;
  patchSession(sessionId: string, patch: Partial<Omit<TtsPlaybackSessionState, 'schemaVersion' | 'sessionId'>>): Promise<void>;
  updateCursor(sessionId: string, ordinal: number, updatedAt?: number): Promise<void>;
}

export interface TtsPlaybackSegmentClaimStore {
  claimSegment(input: {
    storageUserId: string;
    documentId: string;
    documentVersion: number;
    settingsHash: string;
    segmentId: string;
    audioKey: string;
    ownerId?: string | null;
    now?: number;
    staleAfterMs: number;
    // When the caller has confirmed there is no durable (S3) completed artifact
    // for this segment, a lingering `completed` claim is stale — e.g. the user
    // cleared cached audio, which deletes the S3 index/metadata/audio but not the
    // NATS claim. Allow overwriting it so the segment regenerates instead of being
    // permanently skipped. Safe because the index is written before the completed
    // claim, so a completed claim without an index entry can only be cleared state.
    allowReclaimCompleted?: boolean;
  }): Promise<{ claimed: true; claim: TtsPlaybackSegmentClaim } | { claimed: false; claim: TtsPlaybackSegmentClaim | null }>;
  markSegmentClaim(input: {
    storageUserId: string;
    documentId: string;
    documentVersion: number;
    settingsHash: string;
    segmentId: string;
    status: TtsPlaybackSegmentStatus;
    audioKey: string;
    ownerId?: string | null;
    now?: number;
  }): Promise<void>;
}

export interface TtsPlaybackSegmentArtifactStore {
  metadataKey(input: {
    storageUserId: string;
    documentId: string;
    documentVersion: number;
    settingsHash: string;
    segmentId: string;
  }): string;
  indexKey(input: {
    storageUserId: string;
    documentId: string;
    documentVersion: number;
    settingsHash: string;
  }): string;
  putSegmentMetadata(metadata: TtsPlaybackSegmentMetadata): Promise<string>;
  readSegmentMetadata(key: string): Promise<TtsPlaybackSegmentMetadata | null>;
  readSegmentIndex(input: {
    storageUserId: string;
    documentId: string;
    documentVersion: number;
    settingsHash: string;
  }): Promise<TtsPlaybackSegmentIndexArtifact | null>;
}

export interface TtsPlaybackStorage {
  sessions: TtsPlaybackSessionStore;
  claims: TtsPlaybackSegmentClaimStore;
  artifacts: TtsPlaybackSegmentArtifactStore;
}

type KvEntry = Awaited<ReturnType<KvStoreLike['get']>>;

function hashScope(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function isCasConflictError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes('wrong last sequence') || message.includes('key exists') || message.includes('wrong last');
}

function isKvPut(entry: KvEntry): entry is NonNullable<KvEntry> {
  return Boolean(entry && (!entry.operation || entry.operation === 'PUT'));
}

function sessionKvKey(sessionId: string): string {
  return `tts_playback.session.${hashScope(sessionId)}`;
}

function segmentClaimKvKey(input: {
  storageUserId: string;
  documentId: string;
  documentVersion: number;
  settingsHash: string;
  segmentId: string;
}): string {
  return `tts_playback.segment_claim.${hashScope([
    input.storageUserId,
    input.documentId,
    String(Math.max(0, Math.floor(input.documentVersion))),
    input.settingsHash,
    input.segmentId,
  ].join('\0'))}`;
}

export function createTtsPlaybackKvStore(input: {
  getKv: () => Promise<KvStoreLike>;
}): TtsPlaybackSessionStore & TtsPlaybackSegmentClaimStore {
  const sessionCodec = createJsonCodec<TtsPlaybackSessionState>();
  const claimCodec = createJsonCodec<TtsPlaybackSegmentClaim>();

  const getClaim = async (key: string): Promise<{ claim: TtsPlaybackSegmentClaim; revision: number } | null> => {
    const kv = await input.getKv();
    const entry = await kv.get(key);
    if (!isKvPut(entry)) return null;
    return { claim: claimCodec.decode(entry.value), revision: entry.revision };
  };

  return {
    async getSession(sessionId) {
      const kv = await input.getKv();
      const entry = await kv.get(sessionKvKey(sessionId));
      if (!isKvPut(entry)) return null;
      return sessionCodec.decode(entry.value);
    },

    async putSession(state) {
      const kv = await input.getKv();
      await kv.put(sessionKvKey(state.sessionId), sessionCodec.encode(state));
    },

    async patchSession(sessionId, patch) {
      const kv = await input.getKv();
      const key = sessionKvKey(sessionId);
      const entry = await kv.get(key);
      if (!isKvPut(entry)) return;
      const current = sessionCodec.decode(entry.value);
      const next: TtsPlaybackSessionState = {
        ...current,
        ...patch,
        sessionId: current.sessionId,
        schemaVersion: 1,
        updatedAt: patch.updatedAt ?? Date.now(),
      };
      await kv.update(key, sessionCodec.encode(next), entry.revision);
    },

    async updateCursor(sessionId, ordinal, updatedAt = Date.now()) {
      const kv = await input.getKv();
      const key = sessionKvKey(sessionId);
      const entry = await kv.get(key);
      if (!isKvPut(entry)) return;
      const current = sessionCodec.decode(entry.value);
      const next: TtsPlaybackSessionState = {
        ...current,
        cursorOrdinal: Math.max(0, Math.floor(ordinal)),
        cursorUpdatedAt: updatedAt,
        updatedAt,
      };
      await kv.update(key, sessionCodec.encode(next), entry.revision);
    },

    async claimSegment(claimInput) {
      const now = claimInput.now ?? Date.now();
      const key = segmentClaimKvKey(claimInput);
      const next: TtsPlaybackSegmentClaim = {
        schemaVersion: 1,
        status: 'generating',
        storageUserId: claimInput.storageUserId,
        documentId: claimInput.documentId,
        documentVersion: Math.max(0, Math.floor(claimInput.documentVersion)),
        settingsHash: claimInput.settingsHash,
        segmentId: claimInput.segmentId,
        audioKey: claimInput.audioKey,
        updatedAt: now,
        ownerId: claimInput.ownerId ?? null,
      };
      const kv = await input.getKv();
      const current = await getClaim(key);
      if (!current) {
        try {
          await kv.create(key, claimCodec.encode(next));
          return { claimed: true, claim: next };
        } catch (error) {
          if (!isCasConflictError(error)) throw error;
          const raced = await getClaim(key);
          return { claimed: false, claim: raced?.claim ?? null };
        }
      }
      if (current.claim.status === 'completed') {
        // Trust a completed claim unless the caller proved the durable artifact is
        // gone (cleared cache); otherwise overwrite it and regenerate below.
        if (!claimInput.allowReclaimCompleted) return { claimed: false, claim: current.claim };
      } else {
        const stale = current.claim.status !== 'generating'
          || current.claim.updatedAt < now - Math.max(0, claimInput.staleAfterMs);
        if (!stale) return { claimed: false, claim: current.claim };
      }
      try {
        await kv.update(key, claimCodec.encode(next), current.revision);
        return { claimed: true, claim: next };
      } catch (error) {
        if (!isCasConflictError(error)) throw error;
        const raced = await getClaim(key);
        return { claimed: false, claim: raced?.claim ?? null };
      }
    },

    async markSegmentClaim(markInput) {
      const kv = await input.getKv();
      const key = segmentClaimKvKey(markInput);
      const now = markInput.now ?? Date.now();
      const next: TtsPlaybackSegmentClaim = {
        schemaVersion: 1,
        status: markInput.status,
        storageUserId: markInput.storageUserId,
        documentId: markInput.documentId,
        documentVersion: Math.max(0, Math.floor(markInput.documentVersion)),
        settingsHash: markInput.settingsHash,
        segmentId: markInput.segmentId,
        audioKey: markInput.audioKey,
        updatedAt: now,
        ownerId: markInput.ownerId ?? null,
      };
      const current = await getClaim(key);
      if (!current) {
        await kv.put(key, claimCodec.encode(next));
        return;
      }
      await kv.update(key, claimCodec.encode(next), current.revision);
    },
  };
}

export function createTtsPlaybackSegmentArtifactStore(input: {
  storage: ArtifactStorage;
  s3Prefix: string;
}): TtsPlaybackSegmentArtifactStore {
  const metadataFromBytes = (bytes: ArrayBuffer): TtsPlaybackSegmentMetadata => (
    JSON.parse(Buffer.from(bytes).toString('utf8')) as TtsPlaybackSegmentMetadata
  );
  const indexFromBytes = (bytes: ArrayBuffer): TtsPlaybackSegmentIndexArtifact => (
    JSON.parse(Buffer.from(bytes).toString('utf8')) as TtsPlaybackSegmentIndexArtifact
  );
  const indexKey = (scope: {
    storageUserId: string;
    documentId: string;
    documentVersion: number;
    settingsHash: string;
  }) => ttsPlaybackSegmentIndexArtifactKey({
    storageUserHash: hashScope(scope.storageUserId),
    documentId: scope.documentId,
    documentVersion: scope.documentVersion,
    settingsHash: scope.settingsHash,
    prefix: input.s3Prefix,
  });
  const metadataKey = (scope: {
    storageUserId: string;
    documentId: string;
    documentVersion: number;
    settingsHash: string;
    segmentId: string;
  }) => ttsPlaybackSegmentMetadataArtifactKey({
    storageUserHash: hashScope(scope.storageUserId),
    documentId: scope.documentId,
    documentVersion: scope.documentVersion,
    settingsHash: scope.settingsHash,
    segmentId: scope.segmentId,
    prefix: input.s3Prefix,
  });
  const readIndexByKey = async (key: string): Promise<TtsPlaybackSegmentIndexArtifact | null> => {
    try {
      return indexFromBytes(await input.storage.readObject(key));
    } catch {
      return null;
    }
  };

  return {
    metadataKey,
    indexKey,

    async putSegmentMetadata(metadata) {
      const key = metadataKey(metadata);
      await input.storage.putObject(
        key,
        Buffer.from(JSON.stringify(metadata)),
        'application/json',
      );

      const idxKey = indexKey(metadata);
      const storageUserHash = hashScope(metadata.storageUserId);
      const existing = await readIndexByKey(idxKey);
      const entries = new Map<number, TtsPlaybackSegmentIndexEntry>();
      for (const row of existing?.segments ?? []) {
        entries.set(row.segmentIndex, row);
      }
      entries.set(metadata.segmentIndex, {
        segmentIndex: metadata.segmentIndex,
        segmentId: metadata.segmentId,
        segmentKey: metadata.segmentKey,
        metadataKey: key,
        audioKey: metadata.audioKey,
        durationMs: metadata.durationMs,
        status: metadata.status,
        updatedAt: metadata.updatedAt,
      });
      const artifact: TtsPlaybackSegmentIndexArtifact = {
        schemaVersion: 1,
        storageUserHash,
        documentId: metadata.documentId,
        documentVersion: Math.max(0, Math.floor(metadata.documentVersion)),
        settingsHash: metadata.settingsHash,
        updatedAt: Date.now(),
        segments: [...entries.values()].sort((a, b) => a.segmentIndex - b.segmentIndex),
      };
      await input.storage.putObject(
        idxKey,
        Buffer.from(JSON.stringify(artifact)),
        'application/json',
      );
      return key;
    },

    async readSegmentMetadata(key) {
      try {
        return metadataFromBytes(await input.storage.readObject(key));
      } catch {
        return null;
      }
    },

    async readSegmentIndex(scope) {
      return readIndexByKey(indexKey(scope));
    },
  };
}

export function createTtsPlaybackStorage(input: {
  getKv: () => Promise<KvStoreLike>;
  storage: ArtifactStorage;
  s3Prefix: string;
}): TtsPlaybackStorage {
  const kvStore = createTtsPlaybackKvStore({ getKv: input.getKv });
  return {
    sessions: kvStore,
    claims: kvStore,
    artifacts: createTtsPlaybackSegmentArtifactStore({
      storage: input.storage,
      s3Prefix: input.s3Prefix,
    }),
  };
}

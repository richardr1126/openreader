import type { ArtifactStorage } from '../../infrastructure/storage';
import type {
  TtsPlaybackSegmentMetadata,
  TtsPlaybackSessionState,
  TtsPlaybackStorage,
} from '../../playback/storage';

export type PlaybackSessionRow = TtsPlaybackSessionState;

export type PlaybackSegmentState =
  | { status: 'completed'; ordinal: number; audioKey: string; durationMs: number }
  | { status: 'error'; ordinal: number; durationMs: number }
  | { status: 'pending'; ordinal: number };

export type PlaybackSegmentManifestRow = {
  ordinal: number;
  segmentKey: string | null;
  audioKey: string;
  durationMs: number;
  alignmentJson: string | null;
  updatedAt: number | null;
};

export interface PlaybackSessionReadModel {
  readSession(sessionId: string): Promise<PlaybackSessionRow | null>;
  readPlanSegments(planObjectKey: string): Promise<Array<{ ordinal: number; text: string }> | null>;
  readSegmentIndexRows(session: PlaybackSessionRow): Promise<PlaybackSegmentManifestRow[]>;
  readSegmentState(session: PlaybackSessionRow, ordinal: number): Promise<PlaybackSegmentState>;
  listCompletedDurations(session: PlaybackSessionRow, planLength: number): Promise<Map<number, number>>;
  forgetCachedSidecar(session: PlaybackSessionRow, ordinal: number): Promise<void>;
  invalidateSidecarsForScope(scope: PlaybackScope): number;
  invalidatePlansUnderPrefix(prefix: string): number;
}

export interface PlaybackScope {
  storageUserId: string;
  documentId: string;
  documentVersion?: number;
  settingsHash?: string;
}

const SIDECAR_SCOPE_CACHE_MAX = 8;
const SIDECAR_SCAN_AHEAD = 64;
const SIDECAR_FETCH_BATCH = 32;
const PLAN_CACHE_MAX = 4;

function scopeCacheKey(session: PlaybackSessionRow, cacheEpoch: number): string {
  return `${session.storageUserId}\0${session.documentId}\0${Math.max(0, Math.floor(session.documentVersion))}\0${session.settingsHash}\0${Math.max(0, Math.floor(cacheEpoch))}`;
}

function scopeCacheKeyPrefix(scope: PlaybackScope): string {
  return [
    scope.storageUserId,
    scope.documentId,
    scope.documentVersion === undefined ? null : String(Math.max(0, Math.floor(scope.documentVersion))),
    scope.settingsHash ?? null,
  ].filter((part): part is string => part !== null).join('\0');
}

/** Owns playback session reads and the bounded immutable sidecar/plan caches. */
export function createPlaybackSessionReadModel(input: {
  storage: ArtifactStorage;
  playbackStorage?: TtsPlaybackStorage;
}): PlaybackSessionReadModel {
  const { storage, playbackStorage } = input;
  const sidecarScopes = new Map<string, Map<number, TtsPlaybackSegmentMetadata>>();
  const plans = new Map<string, Array<{ ordinal: number; text: string }>>();

  const getScopeEpoch = async (session: PlaybackSessionRow): Promise<number> => {
    return await playbackStorage?.artifacts.getScopeEpoch({
      storageUserId: session.storageUserId,
      documentId: session.documentId,
      documentVersion: session.documentVersion,
      settingsHash: session.settingsHash,
    }).catch(() => 0) ?? 0;
  };

  const getSidecarScope = (
    session: PlaybackSessionRow,
    cacheEpoch: number,
  ): Map<number, TtsPlaybackSegmentMetadata> => {
    const key = scopeCacheKey(session, cacheEpoch);
    let cache = sidecarScopes.get(key);
    if (!cache) {
      if (sidecarScopes.size >= SIDECAR_SCOPE_CACHE_MAX) {
        const oldest = sidecarScopes.keys().next().value;
        if (oldest !== undefined) sidecarScopes.delete(oldest);
      }
      cache = new Map();
      sidecarScopes.set(key, cache);
    }
    return cache;
  };

  const fetchSidecar = async (
    session: PlaybackSessionRow,
    ordinal: number,
    cacheEpoch: number,
  ): Promise<TtsPlaybackSegmentMetadata | null> => {
    const sidecar = await playbackStorage?.artifacts.readSegmentMetadata({
      storageUserId: session.storageUserId,
      documentId: session.documentId,
      documentVersion: session.documentVersion,
      settingsHash: session.settingsHash,
      ordinal,
    }).catch(() => null) ?? null;
    if (!sidecar) return null;
    if (Math.max(0, Math.floor(Number(sidecar.cacheEpoch ?? 0))) < cacheEpoch) return null;
    return sidecar;
  };

  const readSidecar = async (
    session: PlaybackSessionRow,
    ordinal: number,
  ): Promise<TtsPlaybackSegmentMetadata | null> => {
    const cacheEpoch = await getScopeEpoch(session);
    const cache = getSidecarScope(session, cacheEpoch);
    const cached = cache.get(ordinal);
    if (cached) return cached;
    const sidecar = await fetchSidecar(session, ordinal, cacheEpoch);
    if (sidecar?.status === 'completed') cache.set(ordinal, sidecar);
    return sidecar;
  };

  const collectScopeSidecars = async (
    session: PlaybackSessionRow,
    planLength: number,
  ): Promise<Map<number, TtsPlaybackSegmentMetadata>> => {
    const cacheEpoch = await getScopeEpoch(session);
    const cache = getSidecarScope(session, cacheEpoch);
    const result = new Map<number, TtsPlaybackSegmentMetadata>(cache);
    if (planLength <= 0) return result;
    const cursor = Math.max(0, Math.floor(Number(session.cursorOrdinal ?? 0)));
    const highestCached = cache.size > 0 ? Math.max(...cache.keys()) : -1;
    const bandEnd = Math.min(planLength - 1, Math.max(highestCached, cursor) + SIDECAR_SCAN_AHEAD);
    const ordinals: number[] = [];
    for (let ordinal = 0; ordinal <= bandEnd; ordinal += 1) {
      if (cache.get(ordinal)?.status !== 'completed') ordinals.push(ordinal);
    }
    for (let index = 0; index < ordinals.length; index += SIDECAR_FETCH_BATCH) {
      const batch = ordinals.slice(index, index + SIDECAR_FETCH_BATCH);
      const fetched = await Promise.all(batch.map((ordinal) => fetchSidecar(session, ordinal, cacheEpoch)));
      batch.forEach((ordinal, batchIndex) => {
        const sidecar = fetched[batchIndex];
        if (!sidecar) return;
        result.set(ordinal, sidecar);
        if (sidecar.status === 'completed') cache.set(ordinal, sidecar);
      });
    }
    return result;
  };

  const readPlanSegments = async (
    planObjectKey: string,
  ): Promise<Array<{ ordinal: number; text: string }> | null> => {
    const cached = plans.get(planObjectKey);
    if (cached) return cached;
    try {
      const bytes = await storage.readObject(planObjectKey);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
        segments?: Array<{ ordinal?: unknown; text?: unknown }>;
      };
      if (!Array.isArray(parsed.segments)) return null;
      const result: Array<{ ordinal: number; text: string }> = [];
      for (const row of parsed.segments) {
        const ordinal = Number(row.ordinal);
        const text = typeof row.text === 'string' ? row.text : '';
        if (Number.isFinite(ordinal) && text) {
          result.push({ ordinal: Math.max(0, Math.floor(ordinal)), text });
        }
      }
      if (plans.size >= PLAN_CACHE_MAX) {
        const oldest = plans.keys().next().value;
        if (oldest !== undefined) plans.delete(oldest);
      }
      plans.set(planObjectKey, result);
      return result;
    } catch {
      return null;
    }
  };

  return {
    async readSession(sessionId) {
      return await playbackStorage?.sessions.getSession(sessionId) ?? null;
    },
    readPlanSegments,
    async readSegmentIndexRows(session) {
      if (!session.planObjectKey) return [];
      const planSegments = await readPlanSegments(session.planObjectKey);
      if (!planSegments?.length) return [];
      const cacheEpoch = await getScopeEpoch(session);
      const cache = getSidecarScope(session, cacheEpoch);
      const sidecars = new Map<number, TtsPlaybackSegmentMetadata>(cache);
      const missing = planSegments
        .map((segment) => segment.ordinal)
        .filter((ordinal) => cache.get(ordinal)?.status !== 'completed');
      for (let index = 0; index < missing.length; index += SIDECAR_FETCH_BATCH) {
        const batch = missing.slice(index, index + SIDECAR_FETCH_BATCH);
        const fetched = await Promise.all(batch.map((ordinal) => fetchSidecar(session, ordinal, cacheEpoch)));
        batch.forEach((ordinal, batchIndex) => {
          const sidecar = fetched[batchIndex];
          if (!sidecar) return;
          sidecars.set(ordinal, sidecar);
          if (sidecar.status === 'completed') cache.set(ordinal, sidecar);
        });
      }
      return [...sidecars.values()]
        .filter((sidecar): sidecar is TtsPlaybackSegmentMetadata & { status: 'completed'; audioKey: string } => (
          sidecar.status === 'completed' && Boolean(sidecar.audioKey)
        ))
        .map((sidecar) => ({
          ordinal: sidecar.ordinal,
          segmentKey: sidecar.segmentKey,
          audioKey: sidecar.audioKey,
          durationMs: Math.max(1, Number(sidecar.durationMs ?? 1000)),
          alignmentJson: sidecar.alignment ? JSON.stringify(sidecar.alignment) : null,
          updatedAt: sidecar.updatedAt ?? null,
        }))
        .sort((left, right) => left.ordinal - right.ordinal);
    },
    async readSegmentState(session, ordinal) {
      const sidecar = await readSidecar(session, ordinal);
      if (sidecar?.status === 'completed' && sidecar.audioKey) {
        return {
          status: 'completed',
          ordinal: sidecar.ordinal,
          audioKey: sidecar.audioKey,
          durationMs: Math.max(1, Number(sidecar.durationMs ?? 1000)),
        };
      }
      if (sidecar?.status === 'error') {
        return {
          status: 'error',
          ordinal: sidecar.ordinal,
          durationMs: Math.max(1, Number(sidecar.durationMs ?? 1000)),
        };
      }
      return { status: 'pending', ordinal };
    },
    async listCompletedDurations(session, planLength) {
      const sidecars = await collectScopeSidecars(session, planLength);
      const durations = new Map<number, number>();
      for (const sidecar of sidecars.values()) {
        if (sidecar.status === 'completed' && sidecar.audioKey) {
          durations.set(sidecar.ordinal, Math.max(1, Number(sidecar.durationMs ?? 1000)));
        }
      }
      return durations;
    },
    async forgetCachedSidecar(session, ordinal) {
      getSidecarScope(session, await getScopeEpoch(session)).delete(ordinal);
    },
    invalidateSidecarsForScope(scope) {
      const prefix = scopeCacheKeyPrefix(scope);
      let invalidated = 0;
      for (const key of [...sidecarScopes.keys()]) {
        if (key === prefix || key.startsWith(`${prefix}\0`)) {
          sidecarScopes.delete(key);
          invalidated += 1;
        }
      }
      return invalidated;
    },
    invalidatePlansUnderPrefix(prefix) {
      let invalidated = 0;
      for (const key of [...plans.keys()]) {
        if (key.startsWith(prefix)) {
          plans.delete(key);
          invalidated += 1;
        }
      }
      return invalidated;
    },
  };
}

import { buildProportionalAlignment } from '@openreader/tts/segments';
import type { ArtifactStorage } from '../../infrastructure/storage';
import { toErrorMessage } from '../../infrastructure/errors';
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
  alignmentSource: 'proportional' | 'exact' | null;
  updatedAt: number | null;
};

export interface PlaybackSessionReadModel {
  readSession(sessionId: string): Promise<PlaybackSessionRow | null>;
  readPlanSegments(planObjectKey: string): Promise<Array<{ ordinal: number; text: string }> | null>;
  readSegmentIndexRows(
    session: PlaybackSessionRow,
    options?: { minOrdinal?: number; limit?: number },
  ): Promise<PlaybackSegmentManifestRow[]>;
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
const SIDECAR_FETCH_BATCH = 32;
const PLAN_CACHE_MAX = 4;

function isStableCompletedSidecar(
  sidecar: TtsPlaybackSegmentMetadata | null | undefined,
): sidecar is TtsPlaybackSegmentMetadata {
  return sidecar?.status === 'completed' && Boolean(sidecar.alignment);
}

function readSessionLanguage(settingsJson: unknown): string | undefined {
  if (!settingsJson || typeof settingsJson !== 'object') return undefined;
  const language = Reflect.get(settingsJson, 'language');
  return typeof language === 'string' && language.trim() ? language : undefined;
}

function serializeTimelineAlignment(input: {
  sidecar: TtsPlaybackSegmentMetadata;
  text: string | undefined;
  language: string | undefined;
}): Pick<PlaybackSegmentManifestRow, 'alignmentJson' | 'alignmentSource'> {
  if (input.sidecar.alignment) {
    return {
      alignmentJson: JSON.stringify(input.sidecar.alignment),
      alignmentSource: 'exact',
    };
  }
  const durationMs = Number(input.sidecar.durationMs);
  if (!input.text || !Number.isFinite(durationMs) || durationMs <= 0) {
    return { alignmentJson: null, alignmentSource: null };
  }
  const alignment = buildProportionalAlignment({
    sentence: input.text,
    sentenceIndex: input.sidecar.ordinal,
    durationMs,
    language: input.language,
  });
  return alignment.words.length > 0
    ? { alignmentJson: JSON.stringify(alignment), alignmentSource: 'proportional' }
    : { alignmentJson: null, alignmentSource: null };
}

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
  logger?: { warn(data: unknown, message?: string): void };
}): PlaybackSessionReadModel {
  const { storage, playbackStorage, logger } = input;
  const sidecarScopes = new Map<string, Map<number, TtsPlaybackSegmentMetadata>>();
  const scopeCollections = new Map<string, Promise<Map<number, TtsPlaybackSegmentMetadata>>>();
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
    // A completed audio sidecar may still receive its best-effort alignment.
    // Cache it only after word timing is present so a live timeline can observe
    // the backfill instead of retaining the audio-first snapshot indefinitely.
    if (isStableCompletedSidecar(sidecar)) cache.set(ordinal, sidecar);
    return sidecar;
  };

  const collectScopeSidecars = async (
    session: PlaybackSessionRow,
    planLength: number,
  ): Promise<Map<number, TtsPlaybackSegmentMetadata>> => {
    const cacheEpoch = await getScopeEpoch(session);
    const cache = getSidecarScope(session, cacheEpoch);
    if (planLength <= 0) return new Map(cache);
    const key = scopeCacheKey(session, cacheEpoch);
    const pending = scopeCollections.get(key);
    if (pending) return pending;
    const collect = (async () => {
      const result = new Map<number, TtsPlaybackSegmentMetadata>(cache);
      // List only this user/document/version/settings prefix. A deep cursor
      // must not turn thousands of ungenerated ordinals into serial S3 batches.
      // Existing exact timing remains cached across chapter changes; unfinished
      // sidecars are re-read so proportional timing upgrades to exact timing.
      const ordinals = (await playbackStorage?.artifacts.listSegmentOrdinals(session).catch((error) => {
        logger?.warn({
          sessionId: session.sessionId,
          error: toErrorMessage(error),
        }, 'tts.playback.timeline_catalogue_read_failed');
        return [];
      }) ?? [])
        .filter((ordinal) => ordinal < planLength && !isStableCompletedSidecar(cache.get(ordinal)));
      for (let index = 0; index < ordinals.length; index += SIDECAR_FETCH_BATCH) {
        const batch = ordinals.slice(index, index + SIDECAR_FETCH_BATCH);
        const fetched = await Promise.all(batch.map((ordinal) => fetchSidecar(session, ordinal, cacheEpoch)));
        batch.forEach((ordinal, batchIndex) => {
          const sidecar = fetched[batchIndex];
          if (!sidecar) return;
          result.set(ordinal, sidecar);
          if (isStableCompletedSidecar(sidecar)) cache.set(ordinal, sidecar);
        });
      }
      return result;
    })();
    scopeCollections.set(key, collect);
    try {
      return await collect;
    } finally {
      if (scopeCollections.get(key) === collect) scopeCollections.delete(key);
    }
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
    async readSegmentIndexRows(session, options) {
      if (!session.planObjectKey) return [];
      const planSegments = await readPlanSegments(session.planObjectKey);
      if (!planSegments?.length) return [];
      const planTextByOrdinal = new Map(planSegments.map((segment) => [segment.ordinal, segment.text]));
      const language = readSessionLanguage(session.settingsJson);
      if (!options) {
        const sidecars = await collectScopeSidecars(session, planSegments.length);
        return [...sidecars.values()]
          .filter((sidecar): sidecar is TtsPlaybackSegmentMetadata & { status: 'completed'; audioKey: string } => (
            sidecar.status === 'completed' && Boolean(sidecar.audioKey)
          ))
          .map((sidecar) => ({
            ordinal: sidecar.ordinal,
            segmentKey: sidecar.segmentKey,
            audioKey: sidecar.audioKey,
            durationMs: Math.max(1, Number(sidecar.durationMs ?? 1000)),
            ...serializeTimelineAlignment({
              sidecar,
              text: planTextByOrdinal.get(sidecar.ordinal),
              language,
            }),
            updatedAt: sidecar.updatedAt ?? null,
          }))
          .sort((left, right) => left.ordinal - right.ordinal);
      }
      const minOrdinal = Math.max(0, Math.floor(Number(options.minOrdinal ?? 0)));
      const limit = Math.max(1, Math.min(Math.floor(Number(options.limit ?? 500)), 10000));
      // Sidecars are immutable objects rather than rows in an indexed database.
      // Bound reads to the requested ordinal window so a timeline refresh does
      // not issue one object-store miss for every segment in a long document.
      const requestedSegments = planSegments
        .filter((segment) => segment.ordinal >= minOrdinal)
        .slice(0, limit);
      const requestedOrdinals = new Set(requestedSegments.map((segment) => segment.ordinal));
      const cacheEpoch = await getScopeEpoch(session);
      const cache = getSidecarScope(session, cacheEpoch);
      const sidecars = new Map<number, TtsPlaybackSegmentMetadata>(
        [...cache].filter(([ordinal]) => requestedOrdinals.has(ordinal)),
      );
      const missing = requestedSegments
        .map((segment) => segment.ordinal)
        .filter((ordinal) => !isStableCompletedSidecar(cache.get(ordinal)));
      for (let index = 0; index < missing.length; index += SIDECAR_FETCH_BATCH) {
        const batch = missing.slice(index, index + SIDECAR_FETCH_BATCH);
        const fetched = await Promise.all(batch.map((ordinal) => fetchSidecar(session, ordinal, cacheEpoch)));
        batch.forEach((ordinal, batchIndex) => {
          const sidecar = fetched[batchIndex];
          if (!sidecar) return;
          sidecars.set(ordinal, sidecar);
          if (isStableCompletedSidecar(sidecar)) cache.set(ordinal, sidecar);
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
          ...serializeTimelineAlignment({
            sidecar,
            text: planTextByOrdinal.get(sidecar.ordinal),
            language,
          }),
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

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { verifyTtsPlaybackToken } from '@openreader/tts/playback-token';
import { buildTtsPlaybackCanonicalSessionId } from '@openreader/tts/playback-scope';
import { encodeSseFrame } from '../operations';
import type {
  PdfLayoutJobResult,
  WorkerJobTiming,
  WorkerOperationEvent,
  WorkerOperationRequest,
  WorkerOperationState,
  DocumentPreviewArtifactMetadata,
  DocumentPreviewJobResult,
  DocumentConversionArtifactMetadata,
  DocumentConversionJobResult,
  AccountExportArtifactMetadata,
  AccountExportJobResult,
  TtsPlaybackJobResult,
  TtsPlaybackPlanJobResult,
  TtsPlaybackExportArtifactMetadata,
  TtsPlaybackExportArtifactResult,
} from '../operations/contracts';
import { hashOpKey } from '../infrastructure/nats-adapters';
import type { StreamedOperationState } from '../operations/recovery';
import type { ReconciliationStateStore } from '../operations/reconciliation';
import {
  accountExportMetadataArtifactKey,
  documentPreviewMetadataArtifactKey,
  documentConversionMetadataArtifactKey,
  parsedPdfArtifactKey,
  ttsPlaybackExportMetadataArtifactKey,
} from '../storage/artifact-addressing';
import {
  cumulativeCbrFrameBytes,
  getCbrSilenceFrameLengths,
  getCbrSilenceSecond,
  MP3_FRAME_DURATION_MS,
} from '@openreader/tts/audio-format';
import {
  buildByteLayout,
  locateByte,
  parseRangeHeader,
  type PlanSlotInput,
} from './playback-audio-layout';
import {
  buildPdfOperationKey,
  buildDocumentConversionOperationKey,
  buildAccountExportOperationKey,
  buildDocumentPreviewOperationKey,
  buildTtsPlaybackExportOperationKey,
  buildTtsPlaybackOperationKey,
  buildTtsPlaybackPlanOperationKey,
  ttsPlaybackResetScopeFromOperationKey,
} from '../operations/keys';
import { computePlaybackPlanSignature } from '../jobs/handlers';
import { requireEnv } from '../infrastructure/config';
import type { ArtifactStorage } from '../infrastructure/storage';
import type { TtsPlaybackStorage, TtsPlaybackSessionState, TtsPlaybackSegmentMetadata } from '../playback/storage';
import { generationFloorForCursor } from '../playback/generation-window';
import { clearTtsPlaybackArtifacts } from '../playback/cache-clear';
import { cleanupUserStorageArtifacts } from '../storage/user-storage-cleanup';
import { toComputeOperation, type ComputeOperationEvent } from './compute-operation';
import {
  apiErrorResponseSchema,
  jsonSchema,
  operationEventsQuerySchema,
  operationParamsSchema,
  pdfLayoutResolutionSchema,
  pdfOperationCreateSchema,
  pdfResolveSchema,
  computeOperationSchema,
  documentPreviewOperationCreateSchema,
  documentPreviewResolveSchema,
  documentPreviewResolutionSchema,
  documentConversionOperationCreateSchema,
  documentConversionResolveSchema,
  documentConversionResolutionSchema,
  ttsPlaybackPlanOperationCreateSchema,
  ttsPlaybackCursorUpdateSchema,
  ttsPlaybackCacheClearSchema,
  userStorageCleanupSchema,
  ttsPlaybackOperationCreateSchema,
  ttsPlaybackResetSchema,
  ttsPlaybackSessionResolutionSchema,
  ttsPlaybackSessionResolveSchema,
  ttsPlaybackExportArtifactCreateSchema,
  ttsPlaybackExportArtifactMetadataSchema,
  ttsPlaybackExportArtifactResolveSchema,
  ttsPlaybackExportArtifactResolutionSchema,
  accountExportOperationCreateSchema,
  accountExportResolveSchema,
  accountExportResolutionSchema,
} from './schemas';

const OP_EVENTS_KEEPALIVE_MS = 15_000;
const OP_EVENTS_RECONNECT_HINT_MS = 120_000;
const DEFAULT_TTS_PLAYBACK_SESSION_TTL_MS = 30 * 60 * 1000;
const errorResponseSchema = jsonSchema(apiErrorResponseSchema);

interface OperationEventStreamLike {
  subscribe(input: {
    opId: string;
    sinceEventId?: number;
    onEvent: (event: WorkerOperationEvent<PdfLayoutJobResult | TtsPlaybackJobResult | TtsPlaybackPlanJobResult | TtsPlaybackExportArtifactResult | DocumentPreviewJobResult | DocumentConversionJobResult | AccountExportJobResult>) => void | Promise<void>;
    onError?: (error: unknown) => void;
  }): Promise<() => void>;
}

interface OperationStateStoreLike extends ReconciliationStateStore {}

interface OrchestratorLike {
  enqueueOrReuse(request: WorkerOperationRequest): Promise<WorkerOperationState>;
  markRunning(input: {
    opId: string;
    startedAt?: number;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
  markProgress(input: {
    opId: string;
    progress: WorkerOperationState['progress'];
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
  markSucceeded(input: {
    opId: string;
    result: unknown;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
  markFailed(input: {
    opId: string;
    error: { message: string; code?: string } | string;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
  markFailedIfUnchanged?(input: {
    current: StreamedOperationState;
    expectedRevision: number;
    error: { message: string; code?: string } | string;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
}

export interface ComputeWorkerRouteDeps {
  orchestrator: OrchestratorLike;
  operationStateStore: OperationStateStoreLike;
  operationEventStream: OperationEventStreamLike;
  artifactExists?: (key: string) => Promise<boolean>;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : null;
}

function isMissingObjectError(error: unknown): boolean {
  const maybe = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const message = toErrorMessage(error).toLowerCase();
  return maybe.$metadata?.httpStatusCode === 404
    || maybe.name === 'NotFound'
    || maybe.name === 'NoSuchKey'
    || maybe.Code === 'NotFound'
    || maybe.Code === 'NoSuchKey'
    || message.includes('specified key does not exist')
    || message.includes('no such key');
}

function isTerminalStatus(status: import('../operations/contracts').WorkerJobState): boolean {
  return status === 'succeeded' || status === 'failed';
}

function operationMatchesTtsResetScope(
  state: StreamedOperationState,
  scope: {
    documentId: string;
    documentVersion?: number;
    settingsHash?: string;
  },
): boolean {
  const keyScope = ttsPlaybackResetScopeFromOperationKey(state.opKey);
  if (!keyScope) return false;
  return keyScope.documentId === scope.documentId
    && (scope.documentVersion === undefined || keyScope.documentVersion === Math.max(0, Math.floor(scope.documentVersion)))
    && (scope.settingsHash === undefined || keyScope.settingsHash === scope.settingsHash);
}

export function registerComputeWorkerRoutes(input: {
  app: FastifyInstance;
  deps: ComputeWorkerRouteDeps;
  storage: ArtifactStorage;
  playbackStorage?: TtsPlaybackStorage;
  s3Prefix: string;
  ensureOrphanedOpRecovery: () => Promise<void>;
  getOpState: (opId: string) => Promise<StreamedOperationState | null>;
  getNatsConnected: () => boolean;
  releaseHttp: (request: FastifyRequest) => void;
  markActivity: (reason: string) => void;
  onActiveSseChanged: (delta: number) => void;
}) {
  const {
    app,
    deps,
    storage,
    playbackStorage,
    s3Prefix,
    ensureOrphanedOpRecovery,
    getOpState,
    getNatsConnected,
    releaseHttp,
    markActivity,
    onActiveSseChanged,
  } = input;

  type PlaybackSessionRow = TtsPlaybackSessionState;

  type CompletedPlaybackSegment = {
    ordinal: number;
    audioKey: string;
    durationMs: number;
  };

  type PlaybackSegmentState =
    | { status: 'completed'; ordinal: number; audioKey: string; durationMs: number }
    | { status: 'error'; ordinal: number; durationMs: number }
    | { status: 'pending'; ordinal: number };

  type PlaybackSegmentManifestRow = CompletedPlaybackSegment & {
    segmentKey: string | null;
    alignmentJson: string | null;
    updatedAt: number | null;
  };

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  const stripId3Tag = (bytes: Buffer): Buffer => {
    if (bytes.length < 10 || bytes.subarray(0, 3).toString('ascii') !== 'ID3') return bytes;
    const size =
      ((bytes[6] & 0x7f) << 21)
      | ((bytes[7] & 0x7f) << 14)
      | ((bytes[8] & 0x7f) << 7)
      | (bytes[9] & 0x7f);
    const end = 10 + size;
    return end > 0 && end < bytes.length ? bytes.subarray(end) : bytes;
  };

  const readPlaybackSession = async (sessionId: string): Promise<PlaybackSessionRow | null> => {
    return await playbackStorage?.sessions.getSession(sessionId) ?? null;
  };

  const readExportArtifactMetadata = async (artifactId: string): Promise<TtsPlaybackExportArtifactMetadata | null> => {
    const key = ttsPlaybackExportMetadataArtifactKey({ artifactId, prefix: s3Prefix });
    try {
      const bytes = await storage.readObject(key);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as TtsPlaybackExportArtifactMetadata;
      if (parsed.schemaVersion !== 1 || parsed.artifactId !== artifactId || parsed.status !== 'ready') return null;
      if (!await storage.objectExists(parsed.objectKey).catch(() => false)) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const readAccountExportArtifactMetadata = async (input: {
    artifactId: string;
    storageUserId: string;
    namespace: string | null;
    schemaVersion?: number;
    manifestHash?: string;
  }): Promise<AccountExportArtifactMetadata | null> => {
    const key = accountExportMetadataArtifactKey({
      artifactId: input.artifactId,
      storageUserId: input.storageUserId,
      namespace: input.namespace,
      prefix: s3Prefix,
    });
    try {
      const bytes = await storage.readObject(key);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as AccountExportArtifactMetadata;
      if (
        parsed.schemaVersion !== 1
        || parsed.artifactId !== input.artifactId
        || parsed.status !== 'ready'
        || parsed.storageUserId !== input.storageUserId
        || parsed.namespace !== input.namespace
        || (input.schemaVersion !== undefined && parsed.exportSchemaVersion !== input.schemaVersion)
        || (input.manifestHash !== undefined && parsed.manifestHash !== input.manifestHash)
      ) {
        return null;
      }
      if (!await storage.objectExists(parsed.objectKey).catch(() => false)) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const readDocumentPreviewArtifactMetadata = async (input: {
    documentId: string;
    namespace: string | null;
    documentType: 'pdf' | 'epub';
    sourceObjectKey: string;
    sourceLastModifiedMs: number;
    previewKind: 'card';
  }): Promise<DocumentPreviewArtifactMetadata | null> => {
    const key = documentPreviewMetadataArtifactKey({
      documentId: input.documentId,
      namespace: input.namespace,
      prefix: s3Prefix,
    });
    try {
      const bytes = await storage.readObject(key);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as DocumentPreviewArtifactMetadata;
      if (
        parsed.schemaVersion !== 1
        || parsed.documentId !== input.documentId
        || parsed.namespace !== input.namespace
        || parsed.documentType !== input.documentType
        || parsed.sourceObjectKey !== input.sourceObjectKey
        || parsed.sourceLastModifiedMs !== input.sourceLastModifiedMs
        || parsed.previewKind !== input.previewKind
        || parsed.status !== 'ready'
      ) {
        return null;
      }
      if (!await storage.objectExists(parsed.objectKey).catch(() => false)) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const readDocumentConversionArtifactMetadata = async (input: {
    conversionId: string;
    namespace: string | null;
    sourceObjectKey: string;
    sourceLastModifiedMs: number;
    sourceContentType: string;
    sourceEtag?: string | null;
  }): Promise<DocumentConversionArtifactMetadata | null> => {
    const key = documentConversionMetadataArtifactKey({
      conversionId: input.conversionId,
      namespace: input.namespace,
      prefix: s3Prefix,
    });
    try {
      const bytes = await storage.readObject(key);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as DocumentConversionArtifactMetadata;
      if (
        parsed.schemaVersion !== 1
        || parsed.conversionId !== input.conversionId
        || parsed.namespace !== input.namespace
        || parsed.sourceObjectKey !== input.sourceObjectKey
        || parsed.sourceLastModifiedMs !== input.sourceLastModifiedMs
        || parsed.sourceContentType !== input.sourceContentType
        || parsed.sourceEtag !== (input.sourceEtag ?? null)
        || parsed.status !== 'ready'
      ) {
        return null;
      }
      if (!await storage.objectExists(parsed.objectKey).catch(() => false)) return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const invalidateTtsJobOperationsForScope = async (scope: {
    storageUserId: string;
    documentId: string;
    documentVersion?: number;
    settingsHash?: string;
  }, now: number): Promise<number> => {
    if (
      typeof deps.operationStateStore.listOpStates !== 'function'
      || typeof deps.operationStateStore.getOpStateRecord !== 'function'
      || typeof deps.orchestrator.markFailedIfUnchanged !== 'function'
    ) {
      return 0;
    }
    const states = await deps.operationStateStore.listOpStates();
    let invalidated = 0;
    for (const state of states) {
      if (state.kind === 'tts_playback') {
        const sessionId = state.opKey.split('|')[6];
        if (!sessionId) continue;
        const session = await readPlaybackSession(sessionId).catch(() => null);
        if (!session || session.storageUserId !== scope.storageUserId) continue;
      } else if (state.kind === 'tts_playback_export') {
        const artifactId = state.opKey.split('|')[5];
        const metadata = artifactId ? await readExportArtifactMetadata(artifactId) : null;
        if (metadata && metadata.storageUserId !== scope.storageUserId) continue;
        if (!operationMatchesTtsResetScope(state, scope)) continue;
      } else if (!operationMatchesTtsResetScope(state, scope)) {
        continue;
      }
      const record = await deps.operationStateStore.getOpStateRecord(state.opId);
      if (!record) continue;
      if (record.state.kind === 'tts_playback') {
        const sessionId = record.state.opKey.split('|')[6];
        if (!sessionId) continue;
        const session = await readPlaybackSession(sessionId).catch(() => null);
        if (!session || session.storageUserId !== scope.storageUserId) continue;
      } else if (record.state.kind === 'tts_playback_export') {
        const artifactId = record.state.opKey.split('|')[5];
        const metadata = artifactId ? await readExportArtifactMetadata(artifactId) : null;
        if (metadata && metadata.storageUserId !== scope.storageUserId) continue;
        if (!operationMatchesTtsResetScope(record.state, scope)) continue;
      } else if (!operationMatchesTtsResetScope(record.state, scope)) {
        continue;
      }
      const updated = await deps.orchestrator.markFailedIfUnchanged({
        current: record.state,
        expectedRevision: record.revision,
        error: {
          message: 'TTS playback cache was cleared',
          code: 'TTS_PLAYBACK_CACHE_CLEARED',
        },
        updatedAt: now,
      });
      if (updated) invalidated += 1;
    }
    return invalidated;
  };

  // Segment readiness, derived from per-ordinal sidecars.
  //
  // There is no aggregate S3 index any more (it had a lost-update race). Each
  // segment's duration + alignment + status lives in its own immutable sidecar
  // keyed by plan ordinal. Completed sidecars never change (segment audio is
  // content-addressed), so once read they are cached forever; pending/missing
  // ordinals are always re-read so newly-generated segments (possibly from
  // another worker) are picked up. See PLAYBACK_ARCHITECTURE.md (Phase 2).
  const sidecarScopeCache = new Map<string, Map<number, TtsPlaybackSegmentMetadata>>();
  const SIDECAR_SCOPE_CACHE_MAX = 8;
  // How far past the contiguous frontier / playhead to probe for newly-generated
  // sidecars. Generation is forward-contiguous, so a bounded band is enough to
  // discover progress; ordinals outside it are treated as not-yet-generated
  // (silence), which is what the byte layout would use for them anyway.
  const SIDECAR_SCAN_AHEAD = 64;
  const SIDECAR_FETCH_BATCH = 32;

  const sidecarScopeKey = (session: PlaybackSessionRow, cacheEpoch: number): string =>
    `${session.storageUserId}\0${session.documentId}\0${Math.max(0, Math.floor(session.documentVersion))}\0${session.settingsHash}\0${Math.max(0, Math.floor(cacheEpoch))}`;

  const sidecarScopeKeyPrefix = (scope: {
    storageUserId: string;
    documentId: string;
    documentVersion?: number;
    settingsHash?: string;
  }): string => [
    scope.storageUserId,
    scope.documentId,
    scope.documentVersion === undefined ? null : String(Math.max(0, Math.floor(scope.documentVersion))),
    scope.settingsHash ?? null,
  ].filter((part): part is string => part !== null).join('\0');

  const getScopeEpoch = async (session: PlaybackSessionRow): Promise<number> => {
    return await playbackStorage?.artifacts.getScopeEpoch({
      storageUserId: session.storageUserId,
      documentId: session.documentId,
      documentVersion: session.documentVersion,
      settingsHash: session.settingsHash,
    }).catch(() => 0) ?? 0;
  };

  const getSidecarScopeCache = (session: PlaybackSessionRow, cacheEpoch: number): Map<number, TtsPlaybackSegmentMetadata> => {
    const key = sidecarScopeKey(session, cacheEpoch);
    let cache = sidecarScopeCache.get(key);
    if (!cache) {
      if (sidecarScopeCache.size >= SIDECAR_SCOPE_CACHE_MAX) {
        const oldest = sidecarScopeCache.keys().next().value;
        if (oldest !== undefined) sidecarScopeCache.delete(oldest);
      }
      cache = new Map();
      sidecarScopeCache.set(key, cache);
    }
    return cache;
  };

  const forgetCachedSidecar = async (session: PlaybackSessionRow, ordinal: number): Promise<void> => {
    getSidecarScopeCache(session, await getScopeEpoch(session)).delete(ordinal);
  };

  const invalidateCachedSidecarsForScope = (scope: {
    storageUserId: string;
    documentId: string;
    documentVersion?: number;
    settingsHash?: string;
  }): number => {
    const prefix = sidecarScopeKeyPrefix(scope);
    let invalidated = 0;
    for (const key of [...sidecarScopeCache.keys()]) {
      if (key === prefix || key.startsWith(`${prefix}\0`)) {
        sidecarScopeCache.delete(key);
        invalidated += 1;
      }
    }
    return invalidated;
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
      ordinal: ordinal,
    }).catch(() => null) ?? null;
    if (!sidecar) return null;
    if (Math.max(0, Math.floor(Number(sidecar.cacheEpoch ?? 0))) < cacheEpoch) return null;
    return sidecar;
  };

  // Single-ordinal readiness (used by the stream's per-segment wait loop).
  const readSidecarForOrdinal = async (
    session: PlaybackSessionRow,
    ordinal: number,
  ): Promise<TtsPlaybackSegmentMetadata | null> => {
    const cacheEpoch = await getScopeEpoch(session);
    const cache = getSidecarScopeCache(session, cacheEpoch);
    const cached = cache.get(ordinal);
    if (cached) return cached;
    const sidecar = await fetchSidecar(session, ordinal, cacheEpoch);
    if (sidecar?.status === 'completed') cache.set(ordinal, sidecar);
    return sidecar;
  };

  // Collect sidecars for the active region: every cached-completed ordinal plus a
  // bounded band from the start of the document through the active region. The
  // byte layout needs exact durations for the whole prefix below the playhead to
  // place seek offsets, so the band runs [0 .. max(frontier, cursor) + ahead].
  // Completed ordinals in the prefix are served from cache (free), so the only
  // real reads are the not-yet-completed holes and the look-ahead frontier.
  // Returns ordinal -> sidecar for all present (any status); reads are batched in
  // parallel and completed results cached permanently.
  const collectScopeSidecars = async (
    session: PlaybackSessionRow,
    planLength: number,
  ): Promise<Map<number, TtsPlaybackSegmentMetadata>> => {
    const cacheEpoch = await getScopeEpoch(session);
    const cache = getSidecarScopeCache(session, cacheEpoch);
    const result = new Map<number, TtsPlaybackSegmentMetadata>(cache);
    if (planLength <= 0) return result;
    const lastOrdinal = planLength - 1;
    const cursor = Math.max(0, Math.floor(Number(session.cursorOrdinal ?? 0)));
    const highestCached = cache.size > 0 ? Math.max(...cache.keys()) : -1;
    const bandEnd = Math.min(lastOrdinal, Math.max(highestCached, cursor) + SIDECAR_SCAN_AHEAD);
    const ordinals: number[] = [];
    for (let ordinal = 0; ordinal <= bandEnd; ordinal += 1) {
      if (cache.get(ordinal)?.status === 'completed') continue; // already cached → skip the read
      ordinals.push(ordinal);
    }
    for (let i = 0; i < ordinals.length; i += SIDECAR_FETCH_BATCH) {
      const batch = ordinals.slice(i, i + SIDECAR_FETCH_BATCH);
      const fetched = await Promise.all(batch.map((ordinal) => fetchSidecar(session, ordinal, cacheEpoch)));
      batch.forEach((ordinal, idx) => {
        const sidecar = fetched[idx];
        if (!sidecar) return;
        result.set(ordinal, sidecar);
        if (sidecar.status === 'completed') cache.set(ordinal, sidecar);
      });
    }
    return result;
  };

  const readSegmentIndexRows = async (
    session: PlaybackSessionRow,
  ): Promise<PlaybackSegmentManifestRow[]> => {
    if (!session.planObjectKey) return [];
    const planSegments = await readPlanSegments(session.planObjectKey);
    if (!planSegments || planSegments.length === 0) return [];
    // The /segments listing is not on the hot path, so read every sidecar (cached
    // ones are free) to return the full completed set rather than just the band.
    const cacheEpoch = await getScopeEpoch(session);
    const cache = getSidecarScopeCache(session, cacheEpoch);
    const sidecars = new Map<number, TtsPlaybackSegmentMetadata>(cache);
    const missing = planSegments
      .map((seg) => seg.ordinal)
      .filter((ordinal) => cache.get(ordinal)?.status !== 'completed');
    for (let i = 0; i < missing.length; i += SIDECAR_FETCH_BATCH) {
      const batch = missing.slice(i, i + SIDECAR_FETCH_BATCH);
      const fetched = await Promise.all(batch.map((ordinal) => fetchSidecar(session, ordinal, cacheEpoch)));
      batch.forEach((ordinal, idx) => {
        const sidecar = fetched[idx];
        if (!sidecar) return;
        sidecars.set(ordinal, sidecar);
        if (sidecar.status === 'completed') cache.set(ordinal, sidecar);
      });
    }
    const rows: PlaybackSegmentManifestRow[] = [];
    for (const sidecar of sidecars.values()) {
      if (sidecar.status !== 'completed' || !sidecar.audioKey) continue;
      rows.push({
        ordinal: sidecar.ordinal,
        segmentKey: sidecar.segmentKey,
        audioKey: sidecar.audioKey,
        durationMs: Math.max(1, Number(sidecar.durationMs ?? 1000)),
        alignmentJson: sidecar.alignment ? JSON.stringify(sidecar.alignment) : null,
        updatedAt: sidecar.updatedAt ?? null,
      });
    }
    return rows.sort((a, b) => a.ordinal - b.ordinal);
  };

  const readPlaybackSegmentState = async (
    session: PlaybackSessionRow,
    ordinal: number,
  ): Promise<PlaybackSegmentState> => {
    const sidecar = await readSidecarForOrdinal(session, ordinal);
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
  };

  const updatePlaybackCursor = async (sessionId: string, ordinal: number): Promise<void> => {
    const now = Date.now();
    await playbackStorage?.sessions.updateCursor(sessionId, ordinal, now).catch((error) => {
      app.log.warn({ sessionId, error: toErrorMessage(error) }, 'tts.playback.cursor_kv_update_failed');
    });
    const session = await readPlaybackSession(sessionId);
    if (session) {
      await enqueuePlaybackContinuationIfNeeded(session, now, 'stream');
    }
  };

  const putPlaybackSessionState = async (
    requestBody: typeof ttsPlaybackOperationCreateSchema._output,
    status: PlaybackSessionRow['status'],
    workerOpId: string | null,
  ): Promise<void> => {
    const now = Date.now();
    const startOrdinal = Math.max(0, Math.floor(Number(requestBody.planning.selectedOrdinal)));
    await playbackStorage?.sessions.putSession({
      schemaVersion: 1,
      sessionId: requestBody.sessionId,
      userId: requestBody.userId,
      storageUserId: requestBody.storageUserId,
      documentId: requestBody.documentId,
      documentVersion: requestBody.documentVersion,
      readerType: requestBody.readerType,
      status,
      workerOpId,
      settingsHash: requestBody.settingsHash,
      settingsJson: requestBody.settingsJson,
      aheadWindow: requestBody.aheadWindow ?? null,
      backgroundExtent: requestBody.backgroundExtent ?? null,
      generationExtent: requestBody.generationExtent ?? null,
      planning: requestBody.planning,
      generationStartOrdinal: startOrdinal,
      cursorOrdinal: startOrdinal,
      cursorUpdatedAt: now,
      planObjectKey: requestBody.planObjectKey,
      expiresAt: requestBody.expiresAt ?? now + DEFAULT_TTS_PLAYBACK_SESSION_TTL_MS,
      lastError: null,
      updatedAt: now,
    }).catch((error) => {
      app.log.warn({ sessionId: requestBody.sessionId, error: toErrorMessage(error) }, 'tts.playback.session_kv_put_failed');
    });
  };

  const enqueuePlaybackContinuationIfNeeded = async (
    session: PlaybackSessionRow,
    now: number,
    reason: 'cursor' | 'stream',
  ): Promise<void> => {
    if (!playbackStorage) return;
    if (session.status !== 'queued' && session.status !== 'running') return;
    if (now > session.expiresAt) return;
    if (!session.planObjectKey) return;

    if (session.workerOpId) {
      const current = await getOpState(session.workerOpId).catch((error) => {
        app.log.warn({ sessionId: session.sessionId, opId: session.workerOpId, error: toErrorMessage(error) }, 'tts.playback.resume_state_read_failed');
        return null;
      });
      if (current && !isTerminalStatus(current.status)) return;
    }

    const requestBody: typeof ttsPlaybackOperationCreateSchema._output = {
      sessionId: session.sessionId,
      userId: session.userId,
      storageUserId: session.storageUserId,
      documentId: session.documentId,
      documentVersion: session.documentVersion,
      readerType: session.readerType,
      settingsHash: session.settingsHash,
      settingsJson: session.settingsJson,
      planObjectKey: session.planObjectKey,
      generationRunId: `${reason}:${Math.max(0, Math.floor(Number(session.cursorOrdinal ?? 0)))}`,
      expiresAt: session.expiresAt,
      ...(session.aheadWindow == null ? {} : { aheadWindow: session.aheadWindow }),
      ...(session.backgroundExtent == null ? {} : { backgroundExtent: session.backgroundExtent }),
      ...(session.generationExtent == null ? {} : { generationExtent: session.generationExtent }),
      planning: session.planning && typeof session.planning === 'object'
        ? session.planning as typeof ttsPlaybackOperationCreateSchema._output['planning']
        : {},
    };

    const requestOp: WorkerOperationRequest = {
      kind: 'tts_playback',
      opKey: buildTtsPlaybackOperationKey(requestBody),
      payload: requestBody,
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
    await playbackStorage.sessions.patchSession(session.sessionId, {
      status: op.status === 'failed' ? 'failed' : op.status === 'succeeded' ? 'succeeded' : 'running',
      workerOpId: op.opId,
      lastError: op.status === 'failed' ? (op.error?.message ?? 'Failed to enqueue playback continuation') : null,
      updatedAt: now,
    }).catch((error) => {
      app.log.warn({ sessionId: session.sessionId, opId: op.opId, error: toErrorMessage(error) }, 'tts.playback.resume_session_patch_failed');
    });
    app.log.info({
      sessionId: session.sessionId,
      opId: op.opId,
      status: op.status,
      reason,
      opKeyHash: hashOpKey(requestOp.opKey.trim()).slice(0, 16),
    }, 'tts.playback.resume_enqueued');
  };

  // Generous base speaking rate (ms of audio per source character) for *estimating*
  // the not-yet-generated tail. Biased high so the advertised Content-Length stays
  // ≥ the real byte total (the difference is filled with valid CBR silence, never
  // truncated). Scaled by the voice's native speed so fast voices don't get a wildly
  // over-long scrub bar.
  const ESTIMATE_MS_PER_CHAR_BASE = 78;

  const estimateRateForSession = (session: PlaybackSessionRow): number => {
    const speedRaw = (session.settingsJson as { nativeSpeed?: unknown } | null)?.nativeSpeed;
    const speed = Number(speedRaw);
    const clamped = Number.isFinite(speed) && speed > 0 ? Math.min(3, Math.max(0.5, speed)) : 1;
    return ESTIMATE_MS_PER_CHAR_BASE / clamped;
  };

  // Cache parsed plans by object key. Plans are content-addressed (the key encodes
  // doc + version + reader + segmentation signature), so a given key is immutable —
  // caching avoids re-reading and re-parsing a multi-MB whole-book plan on every
  // range request (Safari issues several), which would otherwise block the event
  // loop. Bounded to the few most-recently-used plans.
  const planSegmentsCache = new Map<string, Array<{ ordinal: number; text: string }>>();
  const PLAN_CACHE_MAX = 4;

  // Read the whole position-independent plan (segment index + text) from storage.
  const readPlanSegments = async (
    planObjectKey: string,
  ): Promise<Array<{ ordinal: number; text: string }> | null> => {
    const cached = planSegmentsCache.get(planObjectKey);
    if (cached) return cached;
    try {
      const bytes = await storage.readObject(planObjectKey);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as {
        segments?: Array<{ ordinal?: unknown; text?: unknown }>;
      };
      if (!Array.isArray(parsed.segments)) return null;
      const out: Array<{ ordinal: number; text: string }> = [];
      for (const row of parsed.segments) {
        const ordinal = Number(row.ordinal);
        const text = typeof row.text === 'string' ? row.text : '';
        if (Number.isFinite(ordinal) && text) {
          out.push({ ordinal: Math.max(0, Math.floor(ordinal)), text });
        }
      }
      if (planSegmentsCache.size >= PLAN_CACHE_MAX) {
        const oldest = planSegmentsCache.keys().next().value;
        if (oldest !== undefined) planSegmentsCache.delete(oldest);
      }
      planSegmentsCache.set(planObjectKey, out);
      return out;
    } catch {
      return null;
    }
  };

  // Map of ordinal → exact probed durationMs for every completed segment in the
  // active region (drives exact byte offsets for seeking). Built from per-ordinal
  // sidecars via the bounded, cached band scan — no aggregate index.
  const listCompletedDurations = async (
    session: PlaybackSessionRow,
    planLength: number,
  ): Promise<Map<number, number>> => {
    const sidecars = await collectScopeSidecars(session, planLength);
    const map = new Map<number, number>();
    for (const sidecar of sidecars.values()) {
      if (sidecar.status === 'completed' && sidecar.audioKey) {
        map.set(Number(sidecar.ordinal), Math.max(1, Number(sidecar.durationMs ?? 1000)));
      }
    }
    return map;
  };

  app.get('/health/live', {
    schema: {
      security: [],
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
    },
  }, async () => ({ ok: true }));

  app.get('/health/ready', {
    schema: {
      security: [],
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, natsConnected: { type: 'boolean' } },
          required: ['ok', 'natsConnected'],
        },
      },
    },
  }, async () => ({ ok: true, natsConnected: getNatsConnected() }));

  app.get('/v1/tts-playback/exports/:artifactId', {
    schema: {
      params: {
        type: 'object',
        properties: { artifactId: { type: 'string' } },
        required: ['artifactId'],
      },
      response: {
        200: jsonSchema(ttsPlaybackExportArtifactMetadataSchema),
        400: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const params = request.params as { artifactId?: string };
    const artifactId = params.artifactId?.trim() ?? '';
    if (!artifactId) {
      reply.code(400);
      return { error: 'Missing export artifact id' };
    }
    const artifact = await readExportArtifactMetadata(artifactId);
    if (!artifact) {
      reply.code(404);
      return { error: 'Export artifact not found' };
    }
    return artifact;
  });

  app.post('/v1/tts-playback/sessions/resolve', {
    schema: {
      body: jsonSchema(ttsPlaybackSessionResolveSchema),
      response: {
        200: jsonSchema(ttsPlaybackSessionResolutionSchema),
        400: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackSessionResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    if (!playbackStorage) {
      reply.code(503);
      return { error: 'TTS playback storage is unavailable' };
    }

    const sessionId = buildTtsPlaybackCanonicalSessionId(parsed.data);
    const session = await readPlaybackSession(sessionId);
    const operation = session?.workerOpId
      ? await getOpState(session.workerOpId).catch((error) => {
        app.log.warn({ sessionId, opId: session.workerOpId, error: toErrorMessage(error) }, 'tts.playback.resolve_state_read_failed');
        return null;
      })
      : null;
    const progress = operation?.kind === 'tts_playback' && operation.progress && 'completedCount' in operation.progress
      ? operation.progress
      : null;

    return {
      sessionId,
      session,
      operation: operation ? toComputeOperation(operation) : null,
      progress,
    };
  });

  app.get('/v1/tts-playback/sessions/:sessionId', {
    schema: {
      params: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
      response: { 400: errorResponseSchema, 404: errorResponseSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId?.trim() ?? '';
    if (!sessionId) {
      reply.code(400);
      return { error: 'Missing playback session id' };
    }
    const session = await readPlaybackSession(sessionId);
    if (!session) {
      reply.code(404);
      return { error: 'Playback session not found' };
    }
    return session;
  });

  app.get('/v1/tts-playback/sessions/:sessionId/segments', {
    schema: {
      params: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
      querystring: {
        type: 'object',
        properties: {
          minOrdinal: { type: 'number' },
          limit: { type: 'number' },
        },
      },
      response: { 400: errorResponseSchema, 404: errorResponseSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const query = request.query as { minOrdinal?: string | number; limit?: string | number };
    const sessionId = params.sessionId?.trim() ?? '';
    if (!sessionId) {
      reply.code(400);
      return { error: 'Missing playback session id' };
    }
    const session = await readPlaybackSession(sessionId);
    if (!session) {
      reply.code(404);
      return { error: 'Playback session not found' };
    }
    const minOrdinal = Math.max(0, Math.floor(Number(query.minOrdinal ?? 0)));
    const limit = Math.max(1, Math.min(Math.floor(Number(query.limit ?? 500)), 10000));
    const rows = await readSegmentIndexRows(session);
    return {
      sessionId,
      segments: rows
        .filter((row) => row.ordinal >= minOrdinal)
        .slice(0, limit),
    };
  });

  app.put('/v1/tts-playback/sessions/:sessionId/cursor', {
    schema: {
      params: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
      body: jsonSchema(ttsPlaybackCursorUpdateSchema),
      response: { 400: errorResponseSchema, 404: errorResponseSchema },
    },
  }, async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const sessionId = params.sessionId?.trim() ?? '';
    if (!sessionId) {
      reply.code(400);
      return { error: 'Missing playback session id' };
    }
    const parsed = ttsPlaybackCursorUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    const session = await readPlaybackSession(sessionId);
    if (!session) {
      reply.code(404);
      return { error: 'Playback session not found' };
    }
    const now = Date.now();
    await playbackStorage?.sessions.patchSession(sessionId, {
      cursorOrdinal: parsed.data.ordinal,
      cursorUpdatedAt: now,
      ...(parsed.data.expiresAt === undefined ? {} : { expiresAt: parsed.data.expiresAt }),
      updatedAt: now,
    });
    await enqueuePlaybackContinuationIfNeeded({
      ...session,
      cursorOrdinal: parsed.data.ordinal,
      cursorUpdatedAt: now,
      expiresAt: parsed.data.expiresAt ?? session.expiresAt,
      updatedAt: now,
    }, now, 'cursor');
    return {
      sessionId,
      cursorOrdinal: parsed.data.ordinal,
      expiresAt: parsed.data.expiresAt ?? session.expiresAt,
    };
  });

  app.post('/v1/tts-playback/cache/reset', {
    schema: {
      body: jsonSchema(ttsPlaybackResetSchema),
      response: {
        200: {
          type: 'object',
          properties: {
            storageUserId: { type: 'string' },
            documentId: { type: 'string' },
            documentVersion: { type: 'number', nullable: true },
            settingsHash: { type: 'string', nullable: true },
            cacheEpoch: { type: 'number' },
            invalidatedPlaybackSessions: { type: 'number' },
            invalidatedSidecarCacheScopes: { type: 'number' },
            invalidatedJobOperations: { type: 'number' },
          },
          required: [
            'storageUserId',
            'documentId',
            'documentVersion',
            'settingsHash',
            'cacheEpoch',
            'invalidatedPlaybackSessions',
            'invalidatedSidecarCacheScopes',
            'invalidatedJobOperations',
          ],
        },
        400: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackResetSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    if (!playbackStorage) {
      reply.code(503);
      return { error: 'TTS playback storage is unavailable' };
    }

    const resetScope = parsed.data;
    const now = Date.now();
    const cacheEpoch = await playbackStorage.artifacts.incrementScopeEpoch(resetScope, now);
    const invalidatedPlaybackSessions = await playbackStorage.sessions.cancelSessionsForScope(resetScope, now);
    const invalidatedSidecarCacheScopes = invalidateCachedSidecarsForScope(resetScope);
    const invalidatedJobOperations = await invalidateTtsJobOperationsForScope(resetScope, now);

    app.log.info({
      storageUserId: resetScope.storageUserId,
      documentId: resetScope.documentId,
      documentVersion: resetScope.documentVersion ?? null,
      settingsHash: resetScope.settingsHash ?? null,
      cacheEpoch,
      invalidatedPlaybackSessions,
      invalidatedSidecarCacheScopes,
      invalidatedJobOperations,
    }, 'tts.playback.cache_reset');

    return {
      storageUserId: resetScope.storageUserId,
      documentId: resetScope.documentId,
      documentVersion: resetScope.documentVersion ?? null,
      settingsHash: resetScope.settingsHash ?? null,
      cacheEpoch,
      invalidatedPlaybackSessions,
      invalidatedSidecarCacheScopes,
      invalidatedJobOperations,
    };
  });

  app.post('/v1/tts-playback/cache/clear', {
    schema: {
      body: jsonSchema(ttsPlaybackCacheClearSchema),
      response: {
        200: {
          type: 'object',
          properties: {
            deletedAudioObjects: { type: 'number' },
            deletedSidecarObjects: { type: 'number' },
            deletedPlanObjects: { type: 'number' },
            deletedExportObjects: { type: 'number' },
            invalidatedPlaybackSessions: { type: 'number' },
            invalidatedJobOperations: { type: 'number' },
          },
          required: [
            'deletedAudioObjects',
            'deletedSidecarObjects',
            'deletedPlanObjects',
            'deletedExportObjects',
            'invalidatedPlaybackSessions',
            'invalidatedJobOperations',
          ],
        },
        400: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackCacheClearSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    if (!playbackStorage) {
      reply.code(503);
      return { error: 'TTS playback storage is unavailable' };
    }

    const { namespace, readerType, ...resetScope } = parsed.data;
    const now = Date.now();
    await playbackStorage.artifacts.incrementScopeEpoch(resetScope, now);
    const invalidatedPlaybackSessions = await playbackStorage.sessions.cancelSessionsForScope(resetScope, now);
    invalidateCachedSidecarsForScope(resetScope);
    const invalidatedJobOperations = await invalidateTtsJobOperationsForScope(resetScope, now);
    const deleted = await clearTtsPlaybackArtifacts({
      storage,
      s3Prefix,
      scope: { ...resetScope, namespace, ...(readerType ? { readerType } : {}) },
    });
    return { ...deleted, invalidatedPlaybackSessions, invalidatedJobOperations };
  });

  app.post('/v1/user-storage/cleanup', {
    schema: {
      body: jsonSchema(userStorageCleanupSchema),
      response: {
        200: {
          type: 'object',
          properties: {
            deletedObjects: { type: 'number' },
            deletedDocumentArtifacts: { type: 'number' },
          },
          required: ['deletedObjects', 'deletedDocumentArtifacts'],
        },
        400: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const parsed = userStorageCleanupSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    return cleanupUserStorageArtifacts({ storage, s3Prefix, ...parsed.data });
  });

  app.get('/v1/tts-playback/sessions/:sessionId/audio', {
    schema: {
      security: [],
      params: {
        type: 'object',
        properties: { sessionId: { type: 'string' } },
        required: ['sessionId'],
      },
      querystring: {
        type: 'object',
        properties: { token: { type: 'string' } },
        required: ['token'],
      },
      response: {
        200: { type: 'string', description: 'Progressive MP3 audio stream' },
        206: { type: 'string', description: 'Progressive MP3 audio byte range' },
        400: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
        409: errorResponseSchema,
        416: errorResponseSchema,
        503: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const params = request.params as { sessionId?: string };
    const query = request.query as { token?: string };
    const sessionId = params.sessionId?.trim() ?? '';
    if (!sessionId || !query.token) {
      reply.code(400);
      return { error: 'Missing playback session id or token' };
    }

    let tokenPayload: ReturnType<typeof verifyTtsPlaybackToken>;
    try {
      tokenPayload = verifyTtsPlaybackToken(query.token, requireEnv('TTS_PLAYBACK_TOKEN_SECRET'));
    } catch (error) {
      reply.code(403);
      return { error: toErrorMessage(error) };
    }
    if (tokenPayload.sessionId !== sessionId) {
      reply.code(403);
      return { error: 'Playback token session mismatch' };
    }

    const initialSession = await readPlaybackSession(sessionId);
    if (!initialSession) {
      reply.code(404);
      return { error: 'Playback session not found' };
    }
    if (
      initialSession.userId !== tokenPayload.userId
      || initialSession.storageUserId !== tokenPayload.storageUserId
      || initialSession.documentId !== tokenPayload.documentId
    ) {
      reply.code(403);
      return { error: 'Playback token scope mismatch' };
    }

    let closed = false;
    request.raw.on('close', () => {
      closed = true;
      app.log.info({ sessionId }, 'tts.playback.audio.client_closed');
    });

    const startedAt = Date.now();

    // Resolve a snapshot of the stream layout before sending headers: we need a
    // stable total byte size for Content-Length / seeking. The total is a
    // deterministic char-based estimate over the whole window (independent of how
    // much is generated, so it never changes between range requests), while the
    // byte→ordinal map uses exact durations where generated so seeks land on the
    // correct segment. CBR makes both linear (see STREAM_AUDIO_PROFILE).
    type Layout = { totalBytes: number; slots: ReturnType<typeof buildByteLayout>['slots'] };
    type Resolved =
      | { kind: 'ok'; total: number; mapLayout: Layout }
      | { kind: 'error'; code: 400 | 404 | 409 | 503; message: string };

    const resolveLayout = async (): Promise<Resolved> => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (closed) return { kind: 'error', code: 409, message: 'Client disconnected' };
        const session = await readPlaybackSession(sessionId);
        if (!session) return { kind: 'error', code: 404, message: 'Playback session not found' };
        if (Date.now() > session.expiresAt) {
          return { kind: 'error', code: 404, message: 'Playback session expired' };
        }
        if (session.status !== 'queued' && session.status !== 'running' && session.status !== 'succeeded') {
          return { kind: 'error', code: 409, message: 'Playback session is no longer active' };
        }
        if (session.planObjectKey) {
          const planSegments = await readPlanSegments(session.planObjectKey);
          if (planSegments) {
            const startOrdinal = 0;
            const completed = await listCompletedDurations(session, planSegments.length);
            const estimateRate = estimateRateForSession(session);
            // Size every not-yet-generated (silence) slot in WHOLE MP3 frames, with
            // its exact frame byte length, so the silence we emit decodes to exactly
            // the duration the byte/time grid advertises. Without this, each silence
            // slot is sliced mid-frame and drops a partial frame on decode, drifting
            // the highlight ahead of the audio (worst at deep starts / long prefixes).
            const silenceFrameLengths = await getCbrSilenceFrameLengths().catch(() => [] as number[]);
            const layoutOptions = {
              frameDurationMs: MP3_FRAME_DURATION_MS,
              silenceBytesForFrames: silenceFrameLengths.length > 0
                ? (frames: number) => cumulativeCbrFrameBytes(silenceFrameLengths, frames)
                : undefined,
            };
            // Real durations where generated (so the byte map matches the gapless
            // real audio and seeking lands accurately within the generated region),
            // frame-quantized silence for the not-yet-generated tail.
            const mapSlots: PlanSlotInput[] = planSegments.map((segment) => ({
              ordinal: segment.ordinal,
              text: segment.text,
              durationMs: completed.get(segment.ordinal) ?? null,
            }));
            const totalSlots: PlanSlotInput[] = planSegments.map((segment) => ({
              ordinal: segment.ordinal,
              text: segment.text,
              durationMs: null, // pure estimate → stable Content-Length across requests
            }));
            const mapLayout = buildByteLayout(mapSlots, startOrdinal, estimateRate, layoutOptions);
            const total = buildByteLayout(totalSlots, startOrdinal, estimateRate, layoutOptions).totalBytes;
            return { kind: 'ok', total, mapLayout };
          }
        }
        if (Date.now() > deadline) {
          return { kind: 'error', code: 503, message: 'Playback plan not ready' };
        }
        markActivity('tts_playback_audio_wait');
        await sleep(250);
      }
    };

    const resolved = await resolveLayout();
    if (resolved.kind === 'error') {
      reply.code(resolved.code);
      return { error: resolved.message };
    }
    const { total, mapLayout } = resolved;

    const rangeHeaderRaw = request.headers.range;
    const rangeHeader = Array.isArray(rangeHeaderRaw) ? rangeHeaderRaw[0] : rangeHeaderRaw;
    const parsedRange = parseRangeHeader(rangeHeader, total);

    reply.header('Content-Type', 'audio/mpeg');
    reply.header('Cache-Control', 'private, no-store');
    reply.header('X-Accel-Buffering', 'no');
    reply.header('Accept-Ranges', 'bytes');

    if (parsedRange === 'unsatisfiable') {
      reply.code(416);
      reply.header('Content-Range', `bytes */${total}`);
      return { error: 'Requested range not satisfiable' };
    }

    // null (no Range) and 'invalid' (malformed/multi-range) both serve the full body.
    const range = parsedRange && parsedRange !== 'invalid'
      ? parsedRange
      : { start: 0, end: Math.max(0, total - 1) };

    if (parsedRange && parsedRange !== 'invalid') {
      reply.code(206);
      reply.header('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
    } else {
      reply.code(200);
    }
    reply.header('Content-Length', String(total === 0 ? 0 : range.end - range.start + 1));

    // Stream the requested byte window: real (gapless, ID3-stripped) segment audio
    // from the mapped position, waiting for the worker to generate pending segments,
    // then valid CBR silence to pad up to the advertised length (never truncated).
    const streamRange = async function* (): AsyncGenerator<Buffer> {
      if (total === 0) return;
      const need = range.end - range.start + 1;
      if (need <= 0) return;
      let sent = 0;
      const startLoc = locateByte(mapLayout, range.start);
      let slotIdx = startLoc ? startLoc.slotIndex : mapLayout.slots.length;
      let skipWithin = startLoc ? startLoc.offsetWithin : 0;
      let wroteFirstByte = false;
      let silenceUnit: Buffer | null = null;

      // The ordinal at the requested byte window's start IS the playhead this
      // request will play from. The browser controls it directly, so it is
      // race-proof: unlike `session.cursorOrdinal` (which the client's seek POST
      // may not have landed yet), it always reflects the user's seek target.
      //
      // For any seek (start ordinal > 0) we drive the cursor here so generation
      // re-centers on the target — a forward seek jumps generation ahead, a
      // backward seek (even below the original start) jumps it behind — without
      // depending on the client POST winning the race against this request. We
      // deliberately do NOT do this for the `bytes=0-` probe (start ordinal 0):
      // that request must NOT pull generation back to 0 on a deep start, and it
      // relies on scaffolding silence to complete instantly.
      const rangeStartOrdinal = startLoc ? mapLayout.slots[startLoc.slotIndex].ordinal : 0;
      if (rangeStartOrdinal > 0) {
        await updatePlaybackCursor(sessionId, rangeStartOrdinal).catch((error) => {
          app.log.warn({ sessionId, ordinal: rangeStartOrdinal, error: toErrorMessage(error) }, 'tts.playback.cursor_seed_failed');
        });
      }

      const streamSilence = async function* (byteCount: number): AsyncGenerator<Buffer> {
        let written = 0;
        while (written < byteCount && !closed) {
          if (silenceUnit === null) {
            // ID3-strip the silence unit so it is exactly whole MP3 frames: ffmpeg
            // prepends a ~44B ID3v2 tag, and repeating/slicing a buffer with that
            // tag inline would desync frames and not match the frame-quantized
            // byteLength the layout advertised. The frame table (getCbrSilenceFrameLengths)
            // is already ID3-free, so the stripped buffer and the byte map agree.
            const raw = await getCbrSilenceSecond().catch(() => Buffer.alloc(0));
            silenceUnit = raw.length > 0 ? stripId3Tag(Buffer.from(raw)) : raw;
          }
          const remaining = byteCount - written;
          let chunk: Buffer;
          if (silenceUnit.length > 0) {
            chunk = remaining >= silenceUnit.length ? silenceUnit : silenceUnit.subarray(0, remaining);
          } else {
            chunk = Buffer.alloc(Math.min(remaining, 65536)); // ffmpeg unavailable fallback
          }
          yield chunk;
          written += chunk.length;
        }
      };

      try {
        for (; slotIdx < mapLayout.slots.length && sent < need; slotIdx += 1) {
          const slot = mapLayout.slots[slotIdx];
          const ordinal = slot.ordinal;
          let audioKey: string | null = null;
          let paddedMissingPrefix = false;
          let paddedErrorSegment = false;
          for (;;) {
            if (closed) return;
            const session = await readPlaybackSession(sessionId);
            if (!session || Date.now() > session.expiresAt) return;
            if (session.status !== 'queued' && session.status !== 'running' && session.status !== 'succeeded') {
              return;
            }
            const segmentState = await readPlaybackSegmentState(session, ordinal);
            if (segmentState.status === 'completed') {
              audioKey = segmentState.audioKey;
              break;
            }
            if (segmentState.status === 'error') {
              const room = need - sent;
              const silenceBytes = Math.max(0, Math.min(room, slot.byteLength - skipWithin));
              if (silenceBytes > 0) {
                for await (const chunk of streamSilence(silenceBytes)) {
                  yield chunk;
                  sent += chunk.length;
                }
              }
              skipWithin = 0;
              paddedErrorSegment = true;
              app.log.info({ sessionId, ordinal }, 'tts.playback.audio.skipped_error_segment');
              await updatePlaybackCursor(sessionId, ordinal).catch((error) => {
                app.log.warn({ sessionId, ordinal, error: toErrorMessage(error) }, 'tts.playback.cursor_update_failed');
              });
              break;
            }
            // Scaffolding silence for the never-generated prefix below the current
            // generation floor. The floor is shared with the worker's generation
            // lower bound via generationFloorForCursor (so the two can never drift
            // -> no `bytes=0-` probe hang). A seek request (rangeStartOrdinal > 0)
            // pins the floor to its own start — race-proof, since it never serves
            // ordinals below that anyway — so a backward seek waits for real audio
            // at the target instead of being silenced by a stale higher cursor. The
            // `bytes=0-` probe (rangeStartOrdinal === 0) uses the live cursor so a
            // deep start still emits silence for [0, cursor) and completes at once.
            const silenceFloor = generationFloorForCursor(
              rangeStartOrdinal > 0 ? rangeStartOrdinal : session.cursorOrdinal,
            );
            if (ordinal < silenceFloor) {
              // Emit the slot's whole-frame silence so it decodes to exactly its
              // grid duration.
              const room = need - sent;
              const silenceBytes = Math.max(0, Math.min(room, slot.byteLength - skipWithin));
              if (silenceBytes > 0) {
                for await (const chunk of streamSilence(silenceBytes)) {
                  yield chunk;
                  sent += chunk.length;
                }
              }
              skipWithin = 0;
              paddedMissingPrefix = true;
              break;
            }
            if (session.status === 'succeeded') {
              // Generation finished but this ordinal has no audio (gap / end of the
              // generated extent): stop pulling real audio and pad the rest.
              app.log.info({ sessionId, ordinal }, 'tts.playback.audio.stopped_at_gap');
              break;
            }
            // Still generating (status running): wait for this segment to finish.
            // Forward playback self-paces — generation stays ahead of the cursor (which
            // we advance as we serve), so the segment is on its way. A seek past the
            // frontier issues a new range request and updates the cursor, so generation
            // jumps there; we wait (brief buffering) rather than silencing the rest of
            // the response, which the browser would never re-request.
            //
            // Re-anchor generation to the ordinal we're blocked on: this drives the
            // cursor here and (re)enqueues a continuation. After a forward seek the
            // prior run abandons the skipped gap (its onBeforeSegment floor check),
            // and this re-anchor starts a fresh run AT the target the moment that run
            // frees — so re-centering is prompt instead of waiting for the heartbeat.
            await updatePlaybackCursor(sessionId, ordinal).catch((error) => {
              app.log.warn({ sessionId, ordinal, error: toErrorMessage(error) }, 'tts.playback.cursor_reanchor_failed');
            });
            markActivity('tts_playback_audio_wait');
            await sleep(400);
          }
          if (!audioKey) {
            if (paddedMissingPrefix || paddedErrorSegment) continue;
            break;
          }

          await updatePlaybackCursor(sessionId, ordinal).catch((error) => {
            app.log.warn({ sessionId, ordinal, error: toErrorMessage(error) }, 'tts.playback.cursor_update_failed');
          });
          // Serve the segment's real CBR audio gaplessly — each segment is a whole
          // number of MP3 frames, so concatenation keeps the stream byte↔time linear
          // (and live highlighting accurate). NEVER pad/trim mid-segment: a mid-frame
          // cut drops a partial frame on decode, so playback runs slightly ahead of
          // the byte grid and the highlight drifts behind, accumulating per segment.
          let rawAudio: ArrayBuffer;
          try {
            rawAudio = await storage.readObject(audioKey);
          } catch (error) {
            if (!isMissingObjectError(error)) throw error;
            const session = await readPlaybackSession(sessionId);
            if (session) await forgetCachedSidecar(session, ordinal);
            app.log.warn({
              sessionId,
              ordinal,
              audioKey,
              error: toErrorMessage(error),
            }, 'tts.playback.audio.stale_sidecar_missing_audio');
            await updatePlaybackCursor(sessionId, ordinal).catch((cursorError) => {
              app.log.warn({ sessionId, ordinal, error: toErrorMessage(cursorError) }, 'tts.playback.cursor_reanchor_failed');
            });
            markActivity('tts_playback_audio_wait_missing_audio');
            await sleep(400);
            slotIdx -= 1;
            continue;
          }
          let bytes = stripId3Tag(Buffer.from(rawAudio));
          if (skipWithin > 0) {
            bytes = bytes.subarray(Math.min(skipWithin, bytes.length));
            skipWithin = 0;
          }
          const room = need - sent;
          if (bytes.length > room) bytes = bytes.subarray(0, room);
          if (bytes.length > 0) {
            if (!wroteFirstByte) {
              wroteFirstByte = true;
              app.log.info({ sessionId, ordinal, firstByteMs: Date.now() - startedAt }, 'tts.playback.audio.first_byte');
            }
            markActivity('tts_playback_audio_segment');
            yield bytes;
            sent += bytes.length;
          }
        }

        // Pad up to the advertised length with valid CBR silence — streamed in bounded
        // chunks (reusing the cached ~1s buffer). The pad can be large for a long
        // document (the advertised total is a whole-document estimate), so it must
        // never be materialized as a single buffer.
        if (sent < need && !closed) {
          for await (const chunk of streamSilence(need - sent)) {
            yield chunk;
            sent += chunk.length;
          }
        }
      } catch (error) {
        if (closed || errorCode(error) === 'ERR_STREAM_PREMATURE_CLOSE') {
          app.log.info({ sessionId, sent, need, rangeStart: range.start, rangeEnd: range.end }, 'tts.playback.audio.stream_closed');
          return;
        }
        app.log.error({
          sessionId,
          sent,
          need,
          rangeStart: range.start,
          rangeEnd: range.end,
          slotIdx,
          error: toErrorMessage(error),
          code: errorCode(error),
        }, 'tts.playback.audio.stream_error');
        throw error;
      }
    };

    return Readable.from(streamRange());
  });

  app.post('/v1/pdf-layout/jobs', {
    schema: {
      body: jsonSchema(pdfOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = pdfOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }

    const requestOp: WorkerOperationRequest = {
      kind: 'pdf_layout',
      opKey: buildPdfOperationKey(parsed.data),
      payload: {
        documentId: parsed.data.documentId,
        namespace: parsed.data.namespace,
        documentObjectKey: parsed.data.documentObjectKey,
      },
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
    reply.code(202);
    return toComputeOperation(op);
  });

  app.post('/v1/document-previews/jobs', {
    schema: {
      body: jsonSchema(documentPreviewOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = documentPreviewOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }

    const requestOp: WorkerOperationRequest = {
      kind: 'document_preview',
      opKey: buildDocumentPreviewOperationKey(parsed.data),
      payload: parsed.data,
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
    app.log.info({
      kind: requestOp.kind,
      opId: op.opId,
      jobId: op.jobId,
      status: op.status,
      opKeyHash: hashOpKey(requestOp.opKey.trim()).slice(0, 16),
    }, 'op.accepted');
    reply.code(202);
    return toComputeOperation(op);
  });

  app.post('/v1/document-conversions/docx/jobs', {
    schema: {
      body: jsonSchema(documentConversionOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = documentConversionOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }

    const requestOp: WorkerOperationRequest = {
      kind: 'document_conversion',
      opKey: buildDocumentConversionOperationKey(parsed.data),
      payload: parsed.data,
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
    app.log.info({
      kind: requestOp.kind,
      opId: op.opId,
      jobId: op.jobId,
      status: op.status,
      opKeyHash: hashOpKey(requestOp.opKey.trim()).slice(0, 16),
    }, 'op.accepted');
    reply.code(202);
    return toComputeOperation(op);
  });

  app.post('/v1/tts-playback/sessions/jobs', {
    schema: {
      body: jsonSchema(ttsPlaybackOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    if (parsed.data.planning.selectedOrdinal === undefined) {
      reply.code(400);
      return { error: 'TTS playback operation requires a worker-plan ordinal' };
    }

    await putPlaybackSessionState(parsed.data, 'queued', null);
    const requestOp: WorkerOperationRequest = {
      kind: 'tts_playback',
      opKey: buildTtsPlaybackOperationKey(parsed.data),
      payload: parsed.data,
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
    await playbackStorage?.sessions.patchSession(parsed.data.sessionId, {
      workerOpId: op.opId,
      status: op.status === 'failed' ? 'failed' : op.status === 'succeeded' ? 'succeeded' : 'running',
      lastError: op.status === 'failed' ? op.error?.message ?? 'Failed to enqueue playback operation' : null,
      updatedAt: Date.now(),
    }).catch((error) => {
      app.log.warn({ sessionId: parsed.data.sessionId, opId: op.opId, error: toErrorMessage(error) }, 'tts.playback.session_worker_op_patch_failed');
    });
    app.log.info({
      kind: requestOp.kind,
      opId: op.opId,
      jobId: op.jobId,
      status: op.status,
      opKeyHash: hashOpKey(requestOp.opKey.trim()).slice(0, 16),
    }, 'op.accepted');
    reply.code(202);
    return toComputeOperation(op);
  });

  app.post('/v1/tts-playback/plans/jobs', {
    schema: {
      body: jsonSchema(ttsPlaybackPlanOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackPlanOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }

    const planSignature = computePlaybackPlanSignature({
      ...parsed.data,
      sessionId: `plan:${parsed.data.documentId}:${parsed.data.settingsHash}`,
    });
    const requestOp: WorkerOperationRequest = {
      kind: 'tts_playback_plan',
      opKey: buildTtsPlaybackPlanOperationKey({
        documentId: parsed.data.documentId,
        documentVersion: parsed.data.documentVersion,
        readerType: parsed.data.readerType,
        settingsHash: parsed.data.settingsHash,
        planSignature,
      }),
      payload: parsed.data,
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
    app.log.info({
      kind: requestOp.kind,
      opId: op.opId,
      jobId: op.jobId,
      status: op.status,
      opKeyHash: hashOpKey(requestOp.opKey.trim()).slice(0, 16),
    }, 'op.accepted');
    reply.code(202);
    return toComputeOperation(op);
  });

  app.post('/v1/account-exports/jobs', {
    schema: {
      body: jsonSchema(accountExportOperationCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = accountExportOperationCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }

    const requestOp: WorkerOperationRequest = {
      kind: 'account_export',
      opKey: buildAccountExportOperationKey(parsed.data),
      payload: parsed.data,
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
    app.log.info({
      kind: requestOp.kind,
      opId: op.opId,
      jobId: op.jobId,
      status: op.status,
      opKeyHash: hashOpKey(requestOp.opKey.trim()).slice(0, 16),
    }, 'op.accepted');
    reply.code(202);
    return toComputeOperation(op);
  });

  app.post('/v1/account-exports/resolve', {
    schema: {
      body: jsonSchema(accountExportResolveSchema),
      response: { 200: jsonSchema(accountExportResolutionSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = accountExportResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    await ensureOrphanedOpRecovery();
    const artifact = await readAccountExportArtifactMetadata(parsed.data);
    const opKey = buildAccountExportOperationKey({
      artifactId: parsed.data.artifactId,
      storageUserId: parsed.data.storageUserId,
      namespace: parsed.data.namespace,
      schemaVersion: parsed.data.schemaVersion,
      manifestHash: parsed.data.manifestHash,
    });
    const index = await deps.operationStateStore.getOpIndex?.(opKey);
    const operation = index?.opId ? await deps.operationStateStore.getOpState(index.opId) : null;
    return {
      artifact,
      operation: operation ? toComputeOperation(operation) : null,
    };
  });

  app.post('/v1/tts-playback/exports/jobs', {
    schema: {
      body: jsonSchema(ttsPlaybackExportArtifactCreateSchema),
      response: { 202: jsonSchema(computeOperationSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackExportArtifactCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }

    const requestOp: WorkerOperationRequest = {
      kind: 'tts_playback_export',
      opKey: buildTtsPlaybackExportOperationKey(parsed.data),
      payload: parsed.data,
    };
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
    app.log.info({
      kind: requestOp.kind,
      opId: op.opId,
      jobId: op.jobId,
      status: op.status,
      opKeyHash: hashOpKey(requestOp.opKey.trim()).slice(0, 16),
    }, 'op.accepted');
    reply.code(202);
    return toComputeOperation(op);
  });

  app.post('/v1/tts-playback/exports/resolve', {
    schema: {
      body: jsonSchema(ttsPlaybackExportArtifactResolveSchema),
      response: { 200: jsonSchema(ttsPlaybackExportArtifactResolutionSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = ttsPlaybackExportArtifactResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    await ensureOrphanedOpRecovery();
    const artifact = await readExportArtifactMetadata(parsed.data.artifactId);
    const opKey = buildTtsPlaybackExportOperationKey(parsed.data);
    const index = await deps.operationStateStore.getOpIndex?.(opKey);
    const operation = index?.opId ? await deps.operationStateStore.getOpState(index.opId) : null;
    return {
      artifact,
      operation: operation ? toComputeOperation(operation) : null,
    };
  });

  app.post('/v1/pdf-layout/resolve', {
    schema: {
      body: jsonSchema(pdfResolveSchema),
      response: { 200: jsonSchema(pdfLayoutResolutionSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = pdfResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    await ensureOrphanedOpRecovery();
    const artifactKey = parsedPdfArtifactKey({
      documentId: parsed.data.documentId,
      namespace: parsed.data.namespace,
      prefix: s3Prefix,
    });
    const hasArtifact = await deps.artifactExists?.(artifactKey) ?? false;
    const opKey = buildPdfOperationKey(parsed.data);
    const index = await deps.operationStateStore.getOpIndex?.(opKey);
    const operation = index?.opId ? await deps.operationStateStore.getOpState(index.opId) : null;
    return {
      artifact: hasArtifact ? { objectKey: artifactKey } : null,
      operation: operation ? toComputeOperation(operation) : null,
    };
  });

  app.post('/v1/document-previews/resolve', {
    schema: {
      body: jsonSchema(documentPreviewResolveSchema),
      response: { 200: jsonSchema(documentPreviewResolutionSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = documentPreviewResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    await ensureOrphanedOpRecovery();
    const artifact = await readDocumentPreviewArtifactMetadata(parsed.data);
    const opKey = buildDocumentPreviewOperationKey(parsed.data);
    const index = await deps.operationStateStore.getOpIndex?.(opKey);
    const operation = index?.opId ? await deps.operationStateStore.getOpState(index.opId) : null;
    return {
      artifact,
      operation: operation ? toComputeOperation(operation) : null,
    };
  });

  app.post('/v1/document-conversions/docx/resolve', {
    schema: {
      body: jsonSchema(documentConversionResolveSchema),
      response: { 200: jsonSchema(documentConversionResolutionSchema), 400: errorResponseSchema },
    },
  }, async (request, reply) => {
    const parsed = documentConversionResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'Invalid request body', issues: parsed.error.issues };
    }
    await ensureOrphanedOpRecovery();
    const artifact = await readDocumentConversionArtifactMetadata(parsed.data);
    const opKey = buildDocumentConversionOperationKey(parsed.data);
    const index = await deps.operationStateStore.getOpIndex?.(opKey);
    const operation = index?.opId ? await deps.operationStateStore.getOpState(index.opId) : null;
    return {
      artifact,
      operation: operation ? toComputeOperation(operation) : null,
    };
  });

  app.get('/v1/operations/:opId', {
    schema: {
      params: jsonSchema(operationParamsSchema),
      response: { 200: jsonSchema(computeOperationSchema), 400: errorResponseSchema, 404: errorResponseSchema },
    },
  }, async (request, reply) => {
    const params = operationParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Invalid op id' };
    }

    const state = await getOpState(params.data.opId);
    if (!state) {
      reply.code(404);
      return { error: 'Operation not found' };
    }
    return toComputeOperation(state);
  });

  app.get('/v1/operations/:opId/events', {
    schema: {
      params: jsonSchema(operationParamsSchema),
      querystring: jsonSchema(operationEventsQuerySchema),
      response: {
        200: { type: 'string', description: 'Server-sent ComputeOperationEvent stream' },
        400: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const params = operationParamsSchema.safeParse(request.params);
    if (!params.success) {
      reply.code(400);
      return { error: 'Invalid op id' };
    }

    const initial = await getOpState(params.data.opId);
    if (!initial) {
      reply.code(404);
      return { error: 'Operation not found' };
    }

    const cursorQueryRaw = request.query as { sinceEventId?: string | number | null } | undefined;
    const cursorFromQuery = Number(cursorQueryRaw?.sinceEventId ?? 0);
    const lastEventIdHeader = request.headers['last-event-id'];
    const cursorFromHeader = Number(
      Array.isArray(lastEventIdHeader) ? (lastEventIdHeader[0] ?? 0) : (lastEventIdHeader ?? 0),
    );
    const sinceEventId = Math.max(
      0,
      Number.isFinite(cursorFromQuery) ? Math.floor(cursorFromQuery) : 0,
      Number.isFinite(cursorFromHeader) ? Math.floor(cursorFromHeader) : 0,
    );

    reply.hijack();
    releaseHttp(request);
    onActiveSseChanged(1);
    markActivity('sse_started');
    reply.raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.write(encodeSseFrame({ retry: OP_EVENTS_RECONNECT_HINT_MS }));

    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let keepalive: NodeJS.Timeout | null = null;

    const writeSnapshot = (snapshot: StreamedOperationState, eventId: number): void => {
      if (closed || reply.raw.writableEnded) return;
      const frameEvent: ComputeOperationEvent<
        PdfLayoutJobResult | TtsPlaybackJobResult | TtsPlaybackPlanJobResult | TtsPlaybackExportArtifactResult | DocumentPreviewJobResult | DocumentConversionJobResult | AccountExportJobResult
      > = {
        eventId,
        snapshot: toComputeOperation(snapshot),
      };
      reply.raw.write(encodeSseFrame({ id: eventId, event: 'snapshot', data: frameEvent }));
    };

    const closeStream = (): void => {
      if (closed) return;
      closed = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
      onActiveSseChanged(-1);
      markActivity('sse_closed');
      if (!reply.raw.writableEnded) reply.raw.end();
    };

    request.raw.on('close', closeStream);

    try {
      let current = initial;
      let signature = JSON.stringify(current);
      writeSnapshot(current, sinceEventId > 0 ? sinceEventId : 0);
      if (isTerminalStatus(current.status)) return reply;

      keepalive = setInterval(() => {
        if (!closed && !reply.raw.writableEnded) reply.raw.write(': keepalive\n\n');
      }, OP_EVENTS_KEEPALIVE_MS);

      unsubscribe = await deps.operationEventStream.subscribe({
        opId: params.data.opId,
        sinceEventId,
        onEvent: (event) => {
          if (closed || event.snapshot.opId !== params.data.opId) return;
          const nextSignature = JSON.stringify(event.snapshot);
          if (nextSignature !== signature) {
            current = event.snapshot;
            signature = nextSignature;
            markActivity('sse_event');
            writeSnapshot(current, event.eventId);
          }
          if (isTerminalStatus(event.snapshot.status)) closeStream();
        },
        onError: (error) => {
          app.log.warn({ opId: params.data.opId, error: toErrorMessage(error) }, 'op events stream loop error');
          closeStream();
        },
      });

      await new Promise<void>((resolve) => request.raw.once('close', resolve));
    } catch (error) {
      app.log.warn({ opId: params.data.opId, error: toErrorMessage(error) }, 'op events stream loop error');
    } finally {
      closeStream();
    }
    return reply;
  });
}

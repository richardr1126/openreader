import type { TtsPlaybackJobRequest, TtsPlaybackJobResult, TtsPlaybackProgress } from '../../operations/contracts';
import { generationFloorForCursor } from '../../playback/generation-window';
import type { JobHandlerContext } from '../context';
import { resolveAndPersistTtsPlaybackPlan } from './plan';
import { generateExplicitTtsPlaybackSegments } from './segment-generation';
import { ttsPlaybackRequestSchema } from './schemas';

const DEFAULT_AHEAD_WINDOW = 8;
const CURSOR_STALE_MS = 15_000;

function playbackSectionKey(locator: unknown, readerType: 'pdf' | 'epub' | 'html'): string | null {
  if (!locator || typeof locator !== 'object') return null;
  const rec = locator as Record<string, unknown>;
  if (readerType === 'pdf' && Number.isFinite(Number(rec.page))) return `p${Math.floor(Number(rec.page))}`;
  if (readerType === 'epub' && Number.isFinite(Number(rec.spineIndex))) return `s${Math.floor(Number(rec.spineIndex))}`;
  return null;
}

export function createTtsPlaybackHandler(input: JobHandlerContext) {
  return async function runTtsPlayback(
    payload: TtsPlaybackJobRequest,
    queueWaitMs: number,
    hooks?: { onProgress?: (progress: TtsPlaybackProgress) => Promise<void> },
  ): Promise<TtsPlaybackJobResult> {
    const parsed = ttsPlaybackRequestSchema.parse(payload);
    const startedAt = Date.now();
    if (!input.playbackStorage) throw new Error('TTS playback storage is required');
    const playbackStorage = input.playbackStorage;
    const kvSession = await playbackStorage.sessions.getSession(parsed.sessionId);
    if (!kvSession) throw new Error('TTS playback session no longer exists');
    if (kvSession.status !== 'queued' && kvSession.status !== 'running') {
      throw new Error(kvSession.lastError || `TTS playback session is ${kvSession.status}`);
    }
    try {
      const { planObjectKey, plannedSegments, startOrdinal } = await resolveAndPersistTtsPlaybackPlan({
        request: parsed,
        storage: input.storage,
        s3Prefix: input.s3Prefix,
        requireStartOrdinal: true,
      });
      const isContinuationRun = Boolean(parsed.generationRunId);
      const sessionCursorOrdinal = Math.max(0, Math.floor(Number(kvSession.cursorOrdinal ?? startOrdinal)));
      const sessionCursorUpdatedAt = kvSession.cursorUpdatedAt == null ? null : Number(kvSession.cursorUpdatedAt);
      await playbackStorage.sessions.patchSession(parsed.sessionId, {
        status: 'running',
        planObjectKey,
        generationStartOrdinal: isContinuationRun
          ? Math.max(0, Math.floor(Number(kvSession.generationStartOrdinal ?? startOrdinal)))
          : startOrdinal,
        cursorOrdinal: isContinuationRun ? sessionCursorOrdinal : startOrdinal,
        cursorUpdatedAt: isContinuationRun ? sessionCursorUpdatedAt : Date.now(),
        lastError: null,
      });

      const lastOrdinal = plannedSegments.reduce((max, segment) => Math.max(max, segment.ordinal), -1);
      const aheadWindow = parsed.aheadWindow ?? DEFAULT_AHEAD_WINDOW;
      const backgroundExtent = parsed.backgroundExtent ?? 'section';
      const forceDocumentExtent = parsed.generationExtent === 'document';
      const readCurrentCacheEpoch = async () => playbackStorage.artifacts.getScopeEpoch({
        storageUserId: parsed.storageUserId,
        documentId: parsed.documentId,
        documentVersion: parsed.documentVersion,
        settingsHash: parsed.settingsHash,
      });
      const cacheEpoch = await readCurrentCacheEpoch();
      const completedOrdinals = new Set<number>();
      for (let index = 0; index < plannedSegments.length; index += 32) {
        const sidecars = await Promise.all(plannedSegments.slice(index, index + 32).map((segment) =>
          playbackStorage.artifacts.readSegmentMetadata({
            storageUserId: parsed.storageUserId,
            documentId: parsed.documentId,
            documentVersion: parsed.documentVersion,
            settingsHash: parsed.settingsHash,
            ordinal: segment.ordinal,
          }).catch(() => null)));
        sidecars.forEach((sidecar) => {
          if (sidecar?.status !== 'completed' || !sidecar.audioKey) return;
          if (Math.max(0, Math.floor(Number(sidecar.cacheEpoch ?? 0))) < cacheEpoch) return;
          completedOrdinals.add(sidecar.ordinal);
        });
      }

      const sectionByOrdinal = new Map<number, string | null>();
      for (const segment of plannedSegments) {
        sectionByOrdinal.set(segment.ordinal, playbackSectionKey(segment.locator, parsed.readerType));
      }
      const orderedOrdinals = plannedSegments.map((segment) => segment.ordinal).sort((a, b) => a - b);
      const backgroundTargetFor = (cursorOrdinal: number): number => {
        if (backgroundExtent === 'document') return lastOrdinal;
        const section = sectionByOrdinal.get(cursorOrdinal) ?? null;
        if (section == null) return lastOrdinal;
        let target = cursorOrdinal;
        for (const ordinal of orderedOrdinals) {
          if (ordinal >= cursorOrdinal && (sectionByOrdinal.get(ordinal) ?? null) === section) target = ordinal;
        }
        return target;
      };

      let stoppedEarly = false;
      let lastCompletedThrough = completedOrdinals.size > 0 ? Math.max(...completedOrdinals) : -1;
      const emitProgress = async (): Promise<void> => {
        await hooks?.onProgress?.({
          completedThroughOrdinal: lastCompletedThrough,
          completedCount: completedOrdinals.size,
          plannedCount: plannedSegments.length,
        });
      };
      await emitProgress();

      const onBeforeSegment = async (planOrdinal: number): Promise<'continue' | 'stop'> => {
        const kvCursor = await playbackStorage.sessions.getSession(parsed.sessionId).catch(() => null);
        const cursor = kvCursor ? {
          status: kvCursor.status,
          cursorOrdinal: Math.max(0, Math.floor(Number(kvCursor.cursorOrdinal ?? 0))),
          cursorUpdatedAt: kvCursor.cursorUpdatedAt == null ? null : Number(kvCursor.cursorUpdatedAt),
          expiresAt: Number(kvCursor.expiresAt),
        } : null;
        if (!cursor || (cursor.status !== 'queued' && cursor.status !== 'running') || Date.now() > cursor.expiresAt) {
          stoppedEarly = true;
          return 'stop';
        }
        if (forceDocumentExtent) return 'continue';
        if (planOrdinal < generationFloorForCursor(cursor.cursorOrdinal)) {
          stoppedEarly = true;
          return 'stop';
        }
        const fresh = cursor.cursorUpdatedAt != null && Date.now() - cursor.cursorUpdatedAt <= CURSOR_STALE_MS;
        if (fresh) {
          if (planOrdinal <= cursor.cursorOrdinal + aheadWindow) return 'continue';
          stoppedEarly = true;
          return 'stop';
        }
        if (planOrdinal <= backgroundTargetFor(cursor.cursorOrdinal)) return 'continue';
        stoppedEarly = true;
        return 'stop';
      };
      const onSegmentCompleted = async (planOrdinal: number): Promise<void> => {
        completedOrdinals.add(planOrdinal);
        if (planOrdinal > lastCompletedThrough) lastCompletedThrough = planOrdinal;
        await emitProgress();
      };
      const generationFloor = generationFloorForCursor(isContinuationRun ? sessionCursorOrdinal : startOrdinal);
      const generationSegments = forceDocumentExtent
        ? plannedSegments
        : plannedSegments.filter((segment) => segment.ordinal >= generationFloor);
      await generateExplicitTtsPlaybackSegments({
        request: parsed,
        s3Prefix: input.s3Prefix,
        segments: generationSegments,
        putAudioObject: (key, body) => input.storage.putObject(key, body, 'audio/mpeg'),
        deleteAudioObject: input.storage.deleteObject,
        audioObjectExists: input.storage.objectExists,
        playbackStorage,
        readAudioObject: async (key) => Buffer.from(await input.storage.readObject(key)),
        cacheEpoch,
        getCurrentCacheEpoch: readCurrentCacheEpoch,
        synthesisTimeoutMs: Math.max(input.ttsPlaybackSegmentTimeoutMs, 1_000),
        onBeforeSegment,
        onSegmentCompleted,
        onSegmentErrored: emitProgress,
      });
      const finalSession = await playbackStorage.sessions.getSession(parsed.sessionId).catch(() => null);
      if (!finalSession || (finalSession.status !== 'queued' && finalSession.status !== 'running')) stoppedEarly = true;
      if (await readCurrentCacheEpoch() !== cacheEpoch) stoppedEarly = true;
      if (!stoppedEarly) {
        await playbackStorage.sessions.patchSession(parsed.sessionId, { status: 'succeeded', planObjectKey, lastError: null });
      }
      return { sessionId: parsed.sessionId, planObjectKey, timing: { queueWaitMs, computeMs: Date.now() - startedAt } };
    } catch (error) {
      const latest = await playbackStorage.sessions.getSession(parsed.sessionId).catch(() => null);
      if (latest?.status === 'queued' || latest?.status === 'running') {
        await playbackStorage.sessions.patchSession(parsed.sessionId, {
          status: 'failed',
          lastError: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
      throw error;
    }
  };
}

import { hashOpKey } from '../../infrastructure/nats-adapters';
import type { WorkerOperationRequest } from '../../operations/contracts';
import { buildTtsPlaybackOperationKey } from '../../operations/keys';
import {
  DEFAULT_TTS_PLAYBACK_AHEAD_WINDOW,
  generationFloorForCursor,
} from '../../playback/generation-window';
import { resolveTtsPlaybackSessionInstanceId } from '../../playback/storage';
import { ttsPlaybackOperationCreateSchema } from '../schemas';
import type { ComputeWorkerRouteContext } from '../route-context';
import { isTerminalStatus, toErrorMessage } from '../route-context';
import type { PlaybackSessionReadModel, PlaybackSessionRow } from './session-read-model';

const DEFAULT_TTS_PLAYBACK_SESSION_TTL_MS = 30 * 60 * 1000;

export interface PlaybackSessionController {
  updateCursor(
    sessionId: string,
    ordinal: number,
    options?: { ensureGeneration?: boolean },
  ): Promise<void>;
  enqueueContinuationIfNeeded(
    session: PlaybackSessionRow,
    now: number,
    reason: 'cursor' | 'stream',
  ): Promise<void>;
  putSessionState(
    requestBody: typeof ttsPlaybackOperationCreateSchema._output,
    status: PlaybackSessionRow['status'],
    workerOpId: string | null,
    playbackActive?: boolean,
  ): Promise<void>;
}

export function createPlaybackSessionController(
  context: ComputeWorkerRouteContext,
  readModel: PlaybackSessionReadModel,
): PlaybackSessionController {
  const { app, deps, playbackStorage, ensureOrphanedOpRecovery, getOpState } = context;

  const enqueueContinuationIfNeeded: PlaybackSessionController['enqueueContinuationIfNeeded'] = async (
    session,
    now,
    reason,
  ) => {
    if (!playbackStorage) return;
    if (session.status !== 'queued' && session.status !== 'running') return;
    if (session.playbackActive === false) return;
    if (now > session.expiresAt || !session.planObjectKey) return;
    const cursorOrdinal = Math.max(0, Math.floor(Number(session.cursorOrdinal ?? 0)));
    const aheadWindow = Math.max(1, Math.floor(Number(
      session.aheadWindow ?? DEFAULT_TTS_PLAYBACK_AHEAD_WINDOW,
    )));
    // Refill while roughly three quarters of the window remains. Production
    // queue, object-storage, and provider latency need more runway than the old
    // half-window low-water mark provided.
    const refillThreshold = Math.max(1, Math.ceil(aheadWindow * 0.75));
    const satisfiedFrom = session.generationSatisfiedFromOrdinal == null
      ? null
      : Math.max(0, Math.floor(Number(session.generationSatisfiedFromOrdinal)));
    const satisfiedThrough = session.generationSatisfiedThroughOrdinal == null
      ? null
      : Math.max(0, Math.floor(Number(session.generationSatisfiedThroughOrdinal)));
    if (
      satisfiedFrom !== null
      && satisfiedThrough !== null
      && satisfiedFrom <= generationFloorForCursor(cursorOrdinal)
      && satisfiedThrough >= cursorOrdinal + refillThreshold
      && reason !== 'stream'
    ) return;

    const hasSatisfiedWindow = satisfiedFrom !== null && satisfiedThrough !== null;
    const generationStartOrdinal = Math.max(
      0,
      Math.floor(Number(session.generationStartOrdinal ?? cursorOrdinal)),
    );
    const isExplicitReposition = reason === 'stream' && cursorOrdinal !== generationStartOrdinal;
    if (session.workerOpId) {
      const current = await getOpState(session.workerOpId).catch((error) => {
        app.log.warn(
          { sessionId: session.sessionId, opId: session.workerOpId, error: toErrorMessage(error) },
          'tts.playback.resume_state_read_failed',
        );
        return null;
      });
      // A nonterminal operation normally owns synthesis. Once it has published
      // a satisfied window, however, it may only be draining best-effort exact
      // alignment. Let low-water refill supersede that run so alignment cannot
      // starve audible audio generation.
      if (
        current
        && !isTerminalStatus(current.status)
        && !hasSatisfiedWindow
        && !isExplicitReposition
      ) return;
    }

    // Collapse concurrent signals for the same predecessor, not every future
    // visit to this cursor. A paused/superseded job can finish successfully
    // without filling its window; reusing its key would never resume synthesis.
    const predecessor = hashOpKey(JSON.stringify([
      resolveTtsPlaybackSessionInstanceId(session), session.generationRunId ?? null,
    ])).slice(0, 24);
    const generationRunId = `active:${cursorOrdinal}:${predecessor}`;
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
      generationRunId,
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
    // Claim the canonical session for this deterministic continuation before
    // enqueueing it. A superseded worker observes the changed run id at its next
    // segment boundary and exits without mutating the new run's terminal state.
    const claimed = await playbackStorage.sessions.patchSessionIfGenerationRun(
      session.sessionId,
      session.generationRunId ?? null,
      {
        generationRunId,
        generationSatisfiedFromOrdinal: null,
        generationSatisfiedThroughOrdinal: null,
        updatedAt: now,
      },
    );
    const claimedSession = await readModel.readSession(session.sessionId);
    if (
      !claimedSession
      || claimedSession.playbackActive === false
      || claimedSession.generationRunId !== generationRunId
    ) return;
    await ensureOrphanedOpRecovery();
    const op = await deps.orchestrator.enqueueOrReuse(requestOp);
    await playbackStorage.sessions.patchSessionIfGenerationRun(session.sessionId, generationRunId, {
      status: op.status === 'failed' ? 'failed' : op.status === 'succeeded' ? 'succeeded' : 'running',
      workerOpId: op.opId,
      lastError: op.status === 'failed' ? (op.error?.message ?? 'Failed to enqueue playback continuation') : null,
      updatedAt: now,
    }).catch((error) => {
      app.log.warn(
        { sessionId: session.sessionId, opId: op.opId, error: toErrorMessage(error) },
        'tts.playback.resume_session_patch_failed',
      );
    });
    app.log.info({
      sessionId: session.sessionId,
      opId: op.opId,
      status: op.status,
      reason,
      cursorOrdinal,
      aheadWindow,
      satisfiedFromOrdinal: satisfiedFrom,
      satisfiedThroughOrdinal: satisfiedThrough,
      claimReused: !claimed,
      opKeyHash: hashOpKey(requestOp.opKey.trim()).slice(0, 16),
    }, 'tts.playback.resume_enqueued');
  };

  return {
    enqueueContinuationIfNeeded,
    async updateCursor(sessionId, ordinal, options) {
      const now = Date.now();
      const initialSession = await readModel.readSession(sessionId);
      if (!initialSession) return;
      const cursorUpdated = await playbackStorage?.sessions.updateCursor(
        sessionId,
        ordinal,
        resolveTtsPlaybackSessionInstanceId(initialSession),
        now,
      ).catch((error) => {
        app.log.warn({ sessionId, error: toErrorMessage(error) }, 'tts.playback.cursor_kv_update_failed');
        return false;
      });
      if (!cursorUpdated || !options?.ensureGeneration) return;
      const session = await readModel.readSession(sessionId);
      // Only a stream that is seeking or blocked on missing audio may force a
      // continuation. Ordinary segment delivery updates the cursor without
      // spawning one worker operation per spoken segment.
      if (session) await enqueueContinuationIfNeeded(session, now, 'stream');
    },
    async putSessionState(requestBody, status, workerOpId, playbackActive = true) {
      const now = Date.now();
      const startOrdinal = Math.max(0, Math.floor(Number(requestBody.planning.selectedOrdinal)));
      await playbackStorage?.sessions.putSessionIfNewer({
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
        playbackActive,
        generationRunId: requestBody.generationRunId ?? null,
        generationSatisfiedFromOrdinal: null,
        generationSatisfiedThroughOrdinal: null,
        planning: requestBody.planning,
        generationStartOrdinal: startOrdinal,
        cursorOrdinal: startOrdinal,
        cursorUpdatedAt: now,
        planObjectKey: requestBody.planObjectKey,
        expiresAt: requestBody.expiresAt ?? now + DEFAULT_TTS_PLAYBACK_SESSION_TTL_MS,
        lastError: null,
        updatedAt: now,
      }).catch((error) => {
        app.log.warn(
          { sessionId: requestBody.sessionId, error: toErrorMessage(error) },
          'tts.playback.session_kv_put_failed',
        );
      });
    },
  };
}

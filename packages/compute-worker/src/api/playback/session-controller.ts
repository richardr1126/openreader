import { hashOpKey } from '../../infrastructure/nats-adapters';
import type { WorkerOperationRequest } from '../../operations/contracts';
import { buildTtsPlaybackOperationKey } from '../../operations/keys';
import { ttsPlaybackOperationCreateSchema } from '../schemas';
import type { ComputeWorkerRouteContext } from '../route-context';
import { isTerminalStatus, toErrorMessage } from '../route-context';
import type { PlaybackSessionReadModel, PlaybackSessionRow } from './session-read-model';

const DEFAULT_TTS_PLAYBACK_SESSION_TTL_MS = 30 * 60 * 1000;

export interface PlaybackSessionController {
  updateCursor(sessionId: string, ordinal: number): Promise<void>;
  enqueueContinuationIfNeeded(
    session: PlaybackSessionRow,
    now: number,
    reason: 'cursor' | 'stream',
  ): Promise<void>;
  putSessionState(
    requestBody: typeof ttsPlaybackOperationCreateSchema._output,
    status: PlaybackSessionRow['status'],
    workerOpId: string | null,
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
    if (now > session.expiresAt || !session.planObjectKey) return;

    if (session.workerOpId) {
      const current = await getOpState(session.workerOpId).catch((error) => {
        app.log.warn(
          { sessionId: session.sessionId, opId: session.workerOpId, error: toErrorMessage(error) },
          'tts.playback.resume_state_read_failed',
        );
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
      opKeyHash: hashOpKey(requestOp.opKey.trim()).slice(0, 16),
    }, 'tts.playback.resume_enqueued');
  };

  return {
    enqueueContinuationIfNeeded,
    async updateCursor(sessionId, ordinal) {
      const now = Date.now();
      await playbackStorage?.sessions.updateCursor(sessionId, ordinal, now).catch((error) => {
        app.log.warn({ sessionId, error: toErrorMessage(error) }, 'tts.playback.cursor_kv_update_failed');
      });
      const session = await readModel.readSession(sessionId);
      if (session) await enqueueContinuationIfNeeded(session, now, 'stream');
    },
    async putSessionState(requestBody, status, workerOpId) {
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
        app.log.warn(
          { sessionId: requestBody.sessionId, error: toErrorMessage(error) },
          'tts.playback.session_kv_put_failed',
        );
      });
    },
  };
}

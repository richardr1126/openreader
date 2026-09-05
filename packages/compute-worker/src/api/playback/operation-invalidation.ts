import {
  ttsPlaybackResetScopeFromOperationKey,
  ttsPlaybackSubjectFromOperationKey,
} from '../../operations/keys';
import type { StreamedOperationState } from '../../operations/recovery';
import type { OrchestratorLike, OperationStateStoreLike } from '../route-context';
import type { PlaybackScope, PlaybackSessionRow } from './session-read-model';

export function operationMatchesPlaybackResetScope(
  state: StreamedOperationState,
  scope: PlaybackScope,
): boolean {
  const keyScope = ttsPlaybackResetScopeFromOperationKey(state.opKey);
  if (!keyScope) return false;
  if (keyScope.storageUserId !== null && keyScope.storageUserId !== scope.storageUserId) return false;
  return keyScope.documentId === scope.documentId
    && (scope.documentVersion === undefined
      || keyScope.documentVersion === Math.max(0, Math.floor(scope.documentVersion)))
    && (scope.settingsHash === undefined || keyScope.settingsHash === scope.settingsHash);
}

export async function invalidatePlaybackOperationsForScope(input: {
  scope: PlaybackScope;
  now: number;
  operationStateStore: OperationStateStoreLike;
  orchestrator: OrchestratorLike;
  readSession: (sessionId: string) => Promise<PlaybackSessionRow | null>;
}): Promise<number> {
  const { scope, now, operationStateStore, orchestrator, readSession } = input;
  if (
    typeof operationStateStore.listOpStates !== 'function'
    || typeof operationStateStore.getOpStateRecord !== 'function'
    || typeof orchestrator.markFailedIfUnchanged !== 'function'
  ) {
    return 0;
  }

  const sessions = new Map<string, Promise<PlaybackSessionRow | null>>();
  const belongsToScope = async (state: StreamedOperationState): Promise<boolean> => {
    if (!operationMatchesPlaybackResetScope(state, scope)) return false;
    if (state.kind !== 'tts_playback') return true;
    const subject = ttsPlaybackSubjectFromOperationKey(state.opKey);
    if (!subject) return false;
    let pending = sessions.get(subject.sessionId);
    if (!pending) {
      pending = readSession(subject.sessionId);
      sessions.set(subject.sessionId, pending);
    }
    const session = await pending;
    return session?.storageUserId === scope.storageUserId;
  };

  const states = await operationStateStore.listOpStates();
  let invalidated = 0;
  const candidates = states.filter((state) => state.status !== 'failed'
    && operationMatchesPlaybackResetScope(state, scope));
  for (let index = 0; index < candidates.length; index += 16) {
    await Promise.all(candidates.slice(index, index + 16).map(async (state) => {
      if (!await belongsToScope(state)) return;
      const record = await operationStateStore.getOpStateRecord!(state.opId);
      if (!record || record.state.status === 'failed' || !await belongsToScope(record.state)) return;
      const updated = await orchestrator.markFailedIfUnchanged!({
        current: record.state,
        expectedRevision: record.revision,
        error: {
          message: 'TTS playback cache was cleared',
          code: 'TTS_PLAYBACK_CACHE_CLEARED',
        },
        updatedAt: now,
      });
      if (updated) invalidated += 1;
    }));
  }
  return invalidated;
}

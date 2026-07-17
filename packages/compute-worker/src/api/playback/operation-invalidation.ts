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

  const belongsToScope = async (state: StreamedOperationState): Promise<boolean> => {
    if (state.kind !== 'tts_playback') return operationMatchesPlaybackResetScope(state, scope);
    const subject = ttsPlaybackSubjectFromOperationKey(state.opKey);
    if (!subject) return false;
    const session = await readSession(subject.sessionId).catch(() => null);
    return session?.storageUserId === scope.storageUserId;
  };

  const states = await operationStateStore.listOpStates();
  let invalidated = 0;
  for (const state of states) {
    if (!await belongsToScope(state)) continue;
    const record = await operationStateStore.getOpStateRecord(state.opId);
    if (!record || !await belongsToScope(record.state)) continue;
    const updated = await orchestrator.markFailedIfUnchanged({
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
}

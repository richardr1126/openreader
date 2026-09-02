import { describe, expect, test, vi } from 'vitest';
import type { StreamedOperationState } from '../../src/operations/recovery';
import {
  buildTtsPlaybackOperationKey,
  buildTtsPlaybackPlanOperationKey,
} from '../../src/operations/keys';
import { invalidatePlaybackOperationsForScope } from '../../src/api/playback/operation-invalidation';
import type { OrchestratorLike, OperationStateStoreLike } from '../../src/api/route-context';

function state(input: { opId: string; kind: StreamedOperationState['kind']; opKey: string }): StreamedOperationState {
  return {
    ...input,
    jobId: `job-${input.opId}`,
    status: 'running',
    queuedAt: 1,
    updatedAt: 1,
  } as StreamedOperationState;
}

describe('playback operation invalidation', () => {
  test('uses operation-key subjects for live sessions and reset scopes for derived operations', async () => {
    const scope = {
      storageUserId: 'storage-1',
      documentId: 'document-1',
      documentVersion: 2,
      settingsHash: 'settings-1',
    };
    const live = state({
      opId: 'live',
      kind: 'tts_playback',
      opKey: buildTtsPlaybackOperationKey({
        sessionId: 'session-1',
        storageUserId: scope.storageUserId,
        documentId: scope.documentId,
        documentVersion: scope.documentVersion,
        readerType: 'pdf',
        settingsHash: scope.settingsHash,
        planObjectKey: 'plan.json',
      }),
    });
    const plan = state({
      opId: 'plan',
      kind: 'tts_playback_plan',
      opKey: buildTtsPlaybackPlanOperationKey({
        documentId: scope.documentId,
        documentVersion: scope.documentVersion,
        readerType: 'pdf',
        settingsHash: scope.settingsHash,
        planSignature: 'signature-1',
      }),
    });
    const unrelated = state({
      opId: 'unrelated',
      kind: 'tts_playback_plan',
      opKey: buildTtsPlaybackPlanOperationKey({
        documentId: 'other-document',
        documentVersion: scope.documentVersion,
        readerType: 'pdf',
        settingsHash: scope.settingsHash,
        planSignature: 'signature-2',
      }),
    });
    const rows = [live, plan, unrelated];
    type InvalidationInput = Parameters<NonNullable<OrchestratorLike['markFailedIfUnchanged']>>[0];
    const markFailedIfUnchanged = vi.fn(async (_input: InvalidationInput) => ({ status: 'failed' }));
    const operationStateStore = {
      async listOpStates() { return rows; },
      async getOpStateRecord(opId: string) {
        const row = rows.find((candidate) => candidate.opId === opId);
        return row ? { state: row, revision: 1 } : null;
      },
    } as OperationStateStoreLike;
    const orchestrator = { markFailedIfUnchanged } as unknown as OrchestratorLike;
    const readSession = vi.fn(async (sessionId: string) => sessionId === 'session-1'
      ? { storageUserId: scope.storageUserId }
      : null);

    await expect(invalidatePlaybackOperationsForScope({
      scope,
      now: 100,
      operationStateStore,
      orchestrator,
      readSession: readSession as never,
    })).resolves.toBe(2);
    expect(readSession).toHaveBeenCalledWith('session-1');
    expect(markFailedIfUnchanged).toHaveBeenCalledTimes(2);
    expect(markFailedIfUnchanged.mock.calls.map(([call]) => call.current.opId)).toEqual(['live', 'plan']);
  });
});

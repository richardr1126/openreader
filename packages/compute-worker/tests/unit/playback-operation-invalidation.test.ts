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
    const unrelatedLive = state({
      opId: 'unrelated-live', kind: 'tts_playback',
      opKey: buildTtsPlaybackOperationKey({
        sessionId: 'other-session', storageUserId: scope.storageUserId,
        documentId: 'other-document', documentVersion: scope.documentVersion,
        readerType: 'pdf', settingsHash: scope.settingsHash, planObjectKey: 'other-plan.json',
      }),
    });
    const rows = [live, plan, unrelated, unrelatedLive];
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
    const readSession = vi.fn(async () => ({ storageUserId: scope.storageUserId }));

    await expect(invalidatePlaybackOperationsForScope({
      scope,
      now: 100,
      operationStateStore,
      orchestrator,
      readSession: readSession as never,
    })).resolves.toBe(2);
    expect(readSession).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(markFailedIfUnchanged).toHaveBeenCalledTimes(2);
    expect(markFailedIfUnchanged.mock.calls.map(([call]) => call.current.opId).sort()).toEqual(['live', 'plan']);
  });

  test('bounds concurrent invalidation reads and shares session ownership lookups', async () => {
    const scope = { storageUserId: 'user-1', documentId: 'doc-1' };
    const rows = Array.from({ length: 40 }, (_, i) => state({
      opId: `op-${i}`, kind: 'tts_playback',
      opKey: buildTtsPlaybackOperationKey({
        ...scope, sessionId: 'session-1', documentVersion: 1, readerType: 'html',
        settingsHash: 'settings', planObjectKey: 'plan', generationRunId: `run-${i}`,
      }),
    }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maximum = 0;
    const getOpStateRecord = vi.fn(async (opId: string) => {
      active++;
      maximum = Math.max(active, maximum);
      await gate;
      active--;
      return { state: rows.find((row) => row.opId === opId)!, revision: 1 };
    });
    const readSession = vi.fn(async () => ({ storageUserId: 'user-1' }));
    const run = invalidatePlaybackOperationsForScope({
      scope, now: 100,
      operationStateStore: { listOpStates: async () => rows, getOpStateRecord } as unknown as OperationStateStoreLike,
      orchestrator: { markFailedIfUnchanged: async () => ({ status: 'failed' }) } as unknown as OrchestratorLike,
      readSession: readSession as never,
    });
    await vi.waitFor(() => expect(getOpStateRecord).toHaveBeenCalledTimes(16));
    release();
    expect(await run).toBe(40);
    expect(maximum).toBe(16);
    expect(readSession).toHaveBeenCalledTimes(1);
  });
});

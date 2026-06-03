import { describe, expect, test } from 'vitest';
import type { WorkerOperationRequest } from '../../src/api-contracts';
import { OperationOrchestrator } from '../../src/control-plane';
import {
  InMemoryOperationEventStream,
  InMemoryOperationQueue,
  InMemoryOperationStateStore,
} from '../helpers/in-memory-control-plane';

function buildRequest(opKey: string): WorkerOperationRequest {
  return {
    kind: 'pdf_layout',
    opKey,
    payload: {
      documentId: `doc-${opKey}`,
      namespace: null,
      documentObjectKey: `s3://bucket/${opKey}.pdf`,
    },
  };
}

describe('operation orchestrator', () => {
  test('reuses fresh operation and replaces stale operation', async () => {
    let now = 1_000;
    let nextId = 1;
    const queue = new InMemoryOperationQueue();
    const stateStore = new InMemoryOperationStateStore();
    const eventStream = new InMemoryOperationEventStream();

    const orchestrator = new OperationOrchestrator({
      queue,
      stateStore,
      eventStream,
      config: { opStaleMs: 2_000, maxCasRetries: 5 },
      clock: { now: () => now },
      idFactory: {
        opId: () => `op-${nextId}`,
        jobId: () => `job-${nextId++}`,
      },
    });

    const request = buildRequest('shared-op');

    const first = await orchestrator.enqueueOrReuse(request);
    expect(first.opId).toBe('op-1');

    now = 2_000;
    const reused = await orchestrator.enqueueOrReuse(request);
    expect(reused.opId).toBe('op-1');

    await orchestrator.markRunning({ opId: first.opId, updatedAt: 2_100 });

    now = 6_000;
    const replaced = await orchestrator.enqueueOrReuse(request);
    expect(replaced.opId).toBe('op-2');
    expect(await stateStore.getOpIndex('shared-op')).toEqual({ opId: 'op-2' });
    expect(queue.size('pdf_layout')).toBe(2);
  });

  test('survives transient CAS conflict and eventually creates operation', async () => {
    const queue = new InMemoryOperationQueue();
    const eventStream = new InMemoryOperationEventStream();
    const store = new InMemoryOperationStateStore();

    let firstAttempt = true;
    const conflictStore = {
      getOpState: store.getOpState.bind(store),
      getOpStateRecord: store.getOpStateRecord.bind(store),
      putOpState: store.putOpState.bind(store),
      compareAndSetOpState: store.compareAndSetOpState.bind(store),
      getOpIndex: store.getOpIndex.bind(store),
      compareAndSetOpIndex: async (input: { opKey: string; newOpId: string; expectedOpId: string | null }) => {
        if (firstAttempt && input.expectedOpId === null) {
          firstAttempt = false;
          return false;
        }
        return store.compareAndSetOpIndex(input);
      },
    };

    let id = 1;
    const orchestrator = new OperationOrchestrator({
      queue,
      stateStore: conflictStore,
      eventStream,
      config: { opStaleMs: 2_000, maxCasRetries: 4 },
      idFactory: {
        opId: () => `op-${id}`,
        jobId: () => `job-${id++}`,
      },
    });

    const created = await orchestrator.enqueueOrReuse(buildRequest('cas-key'));
    expect(created.opId).toMatch(/^op-/);
    expect(await store.getOpIndex('cas-key')).toEqual({ opId: created.opId });
  });

  test('markFailedIfUnchanged only writes once for the expected revision', async () => {
    const queue = new InMemoryOperationQueue();
    const stateStore = new InMemoryOperationStateStore();
    const eventStream = new InMemoryOperationEventStream();
    const orchestrator = new OperationOrchestrator({
      queue,
      stateStore,
      eventStream,
      config: { opStaleMs: 2_000, maxCasRetries: 5 },
    });

    const created = await orchestrator.enqueueOrReuse(buildRequest('stale-op'));
    await orchestrator.markRunning({ opId: created.opId, updatedAt: 2_000 });

    const record = await stateStore.getOpStateRecord(created.opId);
    expect(record).not.toBeNull();

    const first = await orchestrator.markFailedIfUnchanged({
      current: record!.state,
      expectedRevision: record!.revision,
      error: { code: 'WORKER_ORPHANED_OP', message: 'stale op' },
      updatedAt: 3_000,
    });
    const second = await orchestrator.markFailedIfUnchanged({
      current: record!.state,
      expectedRevision: record!.revision,
      error: { code: 'WORKER_ORPHANED_OP', message: 'stale op' },
      updatedAt: 3_000,
    });

    expect(first).toMatchObject({
      opId: created.opId,
      status: 'failed',
      error: { code: 'WORKER_ORPHANED_OP' },
    });
    expect(second).toBeNull();

    const events = await eventStream.listSince(created.opId, 0);
    expect(events.filter((event) => event.snapshot.status === 'failed')).toHaveLength(1);
  });
});

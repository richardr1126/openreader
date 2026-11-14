import { describe, expect, test } from 'vitest';
import type { WorkerOperationRequest } from '../../../src/operations/contracts';
import { OperationOrchestrator } from '../../../src/operations/service';
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

    await orchestrator.claimAttempt({ opId: first.opId, jobId: first.jobId, deliveryAttempt: 1, updatedAt: 2_100 });

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
    await orchestrator.claimAttempt({ opId: created.opId, jobId: created.jobId, deliveryAttempt: 1, updatedAt: 2_000 });

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

  test('a late heartbeat or progress write does not reopen a finished operation', async () => {
    const queue = new InMemoryOperationQueue();
    const store = new InMemoryOperationStateStore();
    const eventStream = new InMemoryOperationEventStream();
    let finishDuringRead = false;
    const racingStore = {
      getOpState: store.getOpState.bind(store),
      putOpState: store.putOpState.bind(store),
      compareAndSetOpState: store.compareAndSetOpState.bind(store),
      getOpIndex: store.getOpIndex.bind(store),
      compareAndSetOpIndex: store.compareAndSetOpIndex.bind(store),
      // The heartbeat reads the running state, then the job succeeds before
      // the heartbeat writes it back.
      getOpStateRecord: async (opId: string) => {
        const record = await store.getOpStateRecord(opId);
        if (finishDuringRead) {
          finishDuringRead = false;
          await orchestrator.settleAttempt({
            opId, deliveryAttempt: 1, status: 'succeeded', result: { ok: true }, updatedAt: 3_000,
          });
        }
        return record;
      },
    };
    const orchestrator = new OperationOrchestrator({
      queue,
      stateStore: racingStore,
      eventStream,
      config: { opStaleMs: 2_000, maxCasRetries: 5 },
    });

    const created = await orchestrator.enqueueOrReuse(buildRequest('racing-op'));
    await orchestrator.claimAttempt({ opId: created.opId, jobId: created.jobId, deliveryAttempt: 1, updatedAt: 2_000 });

    finishDuringRead = true;
    const heartbeat = await orchestrator.updateAttempt({ opId: created.opId, deliveryAttempt: 1, updatedAt: 3_100 });
    const progress = await orchestrator.updateAttempt({
      opId: created.opId,
      deliveryAttempt: 1,
      progress: { totalPages: 2, pagesParsed: 2, currentPage: 2, phase: 'merge' },
      updatedAt: 3_200,
    });

    expect(heartbeat).toBe(false);
    expect(progress).toBe(false);
    expect((await store.getOpState(created.opId))?.status).toBe('succeeded');
    const events = await eventStream.listSince(created.opId, 0);
    expect(events.at(-1)?.snapshot.status).toBe('succeeded');
  });

  test('only the latest delivery can write to an operation', async () => {
    const store = new InMemoryOperationStateStore();
    const eventStream = new InMemoryOperationEventStream();
    const deps = { queue: new InMemoryOperationQueue(), stateStore: store, eventStream, config: { opStaleMs: 2_000 } };
    const firstWorker = new OperationOrchestrator(deps);
    const nextWorker = new OperationOrchestrator(deps);
    const { opId, jobId } = await firstWorker.enqueueOrReuse(buildRequest('redelivered'));
    const initial = { opId, jobId, deliveryAttempt: 1, updatedAt: 2_000 };
    const redelivery = { ...initial, deliveryAttempt: 2, updatedAt: 3_000 };

    await expect(firstWorker.claimAttempt(initial)).resolves.toBe('claimed');
    expect(await Promise.all([
      firstWorker.claimAttempt(redelivery),
      nextWorker.claimAttempt(redelivery),
    ])).toEqual(expect.arrayContaining(['claimed', 'superseded']));
    await expect(firstWorker.updateAttempt(initial)).resolves.toBe(false);
    await expect(firstWorker.settleAttempt({ ...initial, status: 'failed', error: { message: 'late' } })).resolves.toBe(false);
    await expect(nextWorker.settleAttempt({ ...redelivery, status: 'succeeded', result: { ok: true } })).resolves.toBe(true);
    await expect(nextWorker.claimAttempt({ ...redelivery, deliveryAttempt: 3 })).resolves.toBe('succeeded');
    expect(await store.getOpState(opId)).toMatchObject({ status: 'succeeded', deliveryAttempt: 2, result: { ok: true } });
  });

  test('a delayed redelivery is eligible only if execution already started before the queue deadline', async () => {
    const stateStore = new InMemoryOperationStateStore();
    const orchestrator = new OperationOrchestrator({
      queue: new InMemoryOperationQueue(), stateStore, eventStream: new InMemoryOperationEventStream(),
      config: { opStaleMs: 2000 },
    });
    const queued = await orchestrator.enqueueOrReuse(buildRequest('queued'));
    const running = await orchestrator.enqueueOrReuse(buildRequest('running'));
    const queueDeadline = 2_000;
    await expect(orchestrator.claimAttempt({ ...running, deliveryAttempt: 1, updatedAt: 1_999, queueDeadline })).resolves.toBe('claimed');
    await expect(orchestrator.claimAttempt({ ...queued, deliveryAttempt: 2, updatedAt: 2_001, queueDeadline })).resolves.toBe('expired');
    expect((await stateStore.getOpState(queued.opId))?.startedAt).toBeUndefined();
    await expect(orchestrator.claimAttempt({ ...running, deliveryAttempt: 2, updatedAt: 2_001, queueDeadline })).resolves.toBe('claimed');
  });

  test('delivery exhaustion closes the matching operation once without overwriting a newer attempt', async () => {
    const store = new InMemoryOperationStateStore();
    const eventStream = new InMemoryOperationEventStream();
    const orchestrator = new OperationOrchestrator({
      queue: new InMemoryOperationQueue(), stateStore: store, eventStream, config: { opStaleMs: 2000 },
    });
    const { opId, jobId } = await orchestrator.enqueueOrReuse(buildRequest('exhausted'));
    const latest = { opId, jobId, deliveryAttempt: 2, updatedAt: Date.now() };
    await orchestrator.claimAttempt(latest);
    await orchestrator.failExhaustedDelivery({ ...latest, jobId: 'different-job' });
    await orchestrator.failExhaustedDelivery({ ...latest, deliveryAttempt: 1 });
    expect((await store.getOpState(opId))?.status).toBe('running');

    await Promise.all([orchestrator.failExhaustedDelivery(latest), orchestrator.failExhaustedDelivery(latest)]);
    expect(await store.getOpState(opId)).toMatchObject({ status: 'failed', error: { code: 'WORKER_ORPHANED_OP' } });
    expect((await eventStream.listSince(opId, 0)).filter((event) => event.snapshot.status === 'failed')).toHaveLength(1);
  });
});

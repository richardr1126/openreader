import { expect, test } from '@playwright/test';
import type { WorkerOperationRequest, WorkerOperationState } from '../../compute/core/src/api-contracts';
import {
  InMemoryOperationEventStream,
  InMemoryOperationQueue,
  InMemoryOperationStateStore,
  OperationOrchestrator,
} from '../../compute/core/src/control-plane';

function buildPdfLayoutRequest(opKey: string): WorkerOperationRequest {
  return {
    kind: 'pdf_layout',
    opKey,
    payload: {
      documentId: `doc-${opKey}`,
      documentObjectKey: `s3://bucket/${opKey}.pdf`,
      namespace: null,
    },
  };
}

test.describe('compute control-plane', () => {
  test('in-memory queue and state store support enqueue/claim/CAS', async () => {
    const queue = new InMemoryOperationQueue();
    const store = new InMemoryOperationStateStore();

    await queue.enqueue({
      jobId: 'job-1',
      opId: 'op-1',
      opKey: 'k-1',
      kind: 'pdf_layout',
      queuedAt: 1000,
      payload: { documentId: 'd1', documentObjectKey: 'obj1', namespace: null },
    });
    await queue.enqueue({
      jobId: 'job-2',
      opId: 'op-2',
      opKey: 'k-2',
      kind: 'whisper_align',
      queuedAt: 1100,
      payload: { text: 'hello', audioObjectKey: 'obj2' },
    });

    expect(queue.size()).toBe(2);
    expect(queue.size('pdf_layout')).toBe(1);
    expect(queue.size('whisper_align')).toBe(1);

    const claimedLayout = await queue.claimNext('pdf_layout');
    expect(claimedLayout?.opId).toBe('op-1');
    expect(queue.size('pdf_layout')).toBe(0);

    const firstCas = await store.compareAndSetOpIndex({
      opKey: 'k-1',
      newOpId: 'op-1',
      expectedOpId: null,
    });
    const secondCas = await store.compareAndSetOpIndex({
      opKey: 'k-1',
      newOpId: 'op-2',
      expectedOpId: null,
    });

    expect(firstCas).toBeTruthy();
    expect(secondCas).toBeFalsy();
    expect(await store.getOpIndex('k-1')).toEqual({ opId: 'op-1' });
  });

  test('in-memory event stream replays from sinceEventId and streams live events', async () => {
    const stream = new InMemoryOperationEventStream();

    const queued: WorkerOperationState = {
      opId: 'op-1',
      opKey: 'k-1',
      kind: 'pdf_layout',
      jobId: 'job-1',
      status: 'queued',
      queuedAt: 1000,
      updatedAt: 1000,
    };
    const running: WorkerOperationState = {
      ...queued,
      status: 'running',
      startedAt: 1200,
      updatedAt: 1200,
    };
    const succeeded: WorkerOperationState = {
      ...running,
      status: 'succeeded',
      updatedAt: 1400,
      result: { ok: true },
    };

    await stream.append('op-1', queued);
    await stream.append('op-1', running);

    const receivedEventIds: number[] = [];
    const unsubscribe = await stream.subscribe({
      opId: 'op-1',
      sinceEventId: 1,
      onEvent: (event) => {
        receivedEventIds.push(event.eventId);
      },
    });

    await stream.append('op-1', succeeded);
    unsubscribe();

    expect(receivedEventIds).toEqual([2, 3]);
  });

  test('orchestrator reuses fresh inflight operations and replaces stale ones', async () => {
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

    const request = buildPdfLayoutRequest('same-op-key');

    const first = await orchestrator.enqueueOrReuse(request);
    expect(first.opId).toBe('op-1');
    expect(queue.size('pdf_layout')).toBe(1);

    now = 2_000;
    const reused = await orchestrator.enqueueOrReuse(request);
    expect(reused.opId).toBe('op-1');
    expect(queue.size('pdf_layout')).toBe(1);

    await orchestrator.markRunning({ opId: first.opId, updatedAt: 2_100 });

    now = 6_000;
    const replaced = await orchestrator.enqueueOrReuse(request);
    expect(replaced.opId).toBe('op-2');
    expect(queue.size('pdf_layout')).toBe(2);
    expect(await stateStore.getOpIndex('same-op-key')).toEqual({ opId: 'op-2' });

    const op1Events = await eventStream.listSince('op-1', 0);
    const op2Events = await eventStream.listSince('op-2', 0);
    expect(op1Events.map((event) => event.eventId)).toEqual([1, 2]);
    expect(op2Events.map((event) => event.eventId)).toEqual([1]);
  });
});

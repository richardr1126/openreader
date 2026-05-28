import { expect, test } from '@playwright/test';
import { OperationOrchestrator } from '../../compute/core/src/control-plane';
import type { WorkerOperationRequest } from '../../compute/core/src/api-contracts';
import {
  JetStreamOperationEventStream,
  JetStreamOperationQueue,
  JetStreamOperationStateStore,
  opEventsSubject,
  opIndexKvKey,
  opStateKvKey,
  type KvEntryLike,
  type KvStoreLike,
} from '../../compute/worker/src/control-plane/jetstream';

class FakeKvStore implements KvStoreLike {
  private readonly data = new Map<string, KvEntryLike>();
  private revision = 0;

  async get(key: string): Promise<KvEntryLike | null> {
    const value = this.data.get(key);
    if (!value) return null;
    return {
      operation: value.operation,
      value: value.value.slice(),
      revision: value.revision,
    };
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    this.revision += 1;
    this.data.set(key, {
      operation: 'PUT',
      value: data.slice(),
      revision: this.revision,
    });
  }

  async create(key: string, data: Uint8Array): Promise<void> {
    if (this.data.has(key)) {
      throw new Error('key exists');
    }
    this.revision += 1;
    this.data.set(key, {
      operation: 'PUT',
      value: data.slice(),
      revision: this.revision,
    });
  }

  async update(key: string, data: Uint8Array, version: number): Promise<void> {
    const current = this.data.get(key);
    if (!current || current.revision !== version) {
      throw new Error('wrong last sequence');
    }
    this.revision += 1;
    this.data.set(key, {
      operation: 'PUT',
      value: data.slice(),
      revision: this.revision,
    });
  }
}

class FakeJetStream {
  private seq = 0;
  readonly published: Array<{ subject: string; payload: unknown; seq: number }> = [];
  readonly consumers = {
    get: async () => {
      throw new Error('not implemented in fake');
    },
  };

  async publish(subject: string, data: Uint8Array): Promise<{ seq: number; stream: string; duplicate: boolean }> {
    this.seq += 1;
    const payload = JSON.parse(new TextDecoder().decode(data)) as unknown;
    this.published.push({ subject, payload, seq: this.seq });
    return { seq: this.seq, stream: 'fake', duplicate: false };
  }
}

function buildPdfRequest(opKey: string): WorkerOperationRequest {
  return {
    kind: 'pdf_layout',
    opKey,
    payload: {
      documentId: 'd1',
      namespace: null,
      documentObjectKey: 's3://bucket/doc.pdf',
    },
  };
}

test.describe('worker jetstream control-plane adapters', () => {
  test('state store compareAndSet handles create/update semantics', async () => {
    const kv = new FakeKvStore();
    const store = new JetStreamOperationStateStore({ getKv: async () => kv });

    const created = await store.compareAndSetOpIndex({
      opKey: 'k1',
      newOpId: 'op-1',
      expectedOpId: null,
    });
    const failedCreate = await store.compareAndSetOpIndex({
      opKey: 'k1',
      newOpId: 'op-2',
      expectedOpId: null,
    });
    const wrongExpected = await store.compareAndSetOpIndex({
      opKey: 'k1',
      newOpId: 'op-2',
      expectedOpId: 'op-x',
    });
    const updated = await store.compareAndSetOpIndex({
      opKey: 'k1',
      newOpId: 'op-2',
      expectedOpId: 'op-1',
    });

    expect(created).toBeTruthy();
    expect(failedCreate).toBeFalsy();
    expect(wrongExpected).toBeFalsy();
    expect(updated).toBeTruthy();
    expect(await store.getOpIndex('k1')).toEqual({ opId: 'op-2' });
  });

  test('queue and event adapters publish expected JetStream subjects', async () => {
    const js = new FakeJetStream();
    const queue = new JetStreamOperationQueue({
      getJs: async () => js as any,
      whisperSubject: 'jobs.whisper',
      layoutSubject: 'jobs.layout',
    });
    const events = new JetStreamOperationEventStream({
      getJs: async () => js as any,
      getJsm: async () => ({
        consumers: {
          add: async () => ({ name: 'noop' }),
          delete: async () => true,
        },
      }) as any,
      eventsStreamName: 'compute_events',
    });

    await queue.enqueue({
      jobId: 'j1',
      opId: 'o1',
      opKey: 'k1',
      kind: 'pdf_layout',
      queuedAt: 1000,
      payload: { documentId: 'd1', namespace: null, documentObjectKey: 'obj' },
    });

    const appended = await events.append('o1', {
      opId: 'o1',
      opKey: 'k1',
      kind: 'pdf_layout',
      jobId: 'j1',
      status: 'queued',
      queuedAt: 1000,
      updatedAt: 1000,
    });

    expect(js.published.map((entry) => entry.subject)).toEqual(['jobs.layout', opEventsSubject('o1')]);
    expect(appended.eventId).toBe(2);
  });

  test('orchestrator integration writes index/state and reuses active op', async () => {
    const kv = new FakeKvStore();
    const js = new FakeJetStream();

    const store = new JetStreamOperationStateStore({ getKv: async () => kv });
    const events = new JetStreamOperationEventStream({
      getJs: async () => js as any,
      getJsm: async () => ({
        consumers: {
          add: async () => ({ name: 'noop' }),
          delete: async () => true,
        },
      }) as any,
      eventsStreamName: 'compute_events',
    });
    const queue = new JetStreamOperationQueue({
      getJs: async () => js as any,
      whisperSubject: 'jobs.whisper',
      layoutSubject: 'jobs.layout',
    });

    let now = 1_000;
    let nextId = 1;
    const orchestrator = new OperationOrchestrator({
      queue,
      stateStore: store,
      eventStream: events,
      config: { opStaleMs: 10_000, maxCasRetries: 3 },
      clock: { now: () => now },
      idFactory: {
        opId: () => `op-${nextId}`,
        jobId: () => `job-${nextId++}`,
      },
    });

    const req = buildPdfRequest('k-integration');
    const first = await orchestrator.enqueueOrReuse(req);
    now = 2_000;
    const reused = await orchestrator.enqueueOrReuse(req);

    expect(first.opId).toBe('op-1');
    expect(reused.opId).toBe('op-1');

    const indexEntry = await kv.get(opIndexKvKey('k-integration'));
    const stateEntry = await kv.get(opStateKvKey('op-1'));
    expect(indexEntry?.operation).toBe('PUT');
    expect(stateEntry?.operation).toBe('PUT');
    expect(js.published.map((entry) => entry.subject)).toEqual(['ops.events.op-1', 'jobs.layout']);
  });
});

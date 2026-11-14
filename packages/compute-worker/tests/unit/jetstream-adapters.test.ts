import { describe, expect, test, vi } from 'vitest';
import { DeliverPolicy } from '@nats-io/jetstream';
import { OperationOrchestrator } from '../../src/operations/service';
import { createTerminalSettlement } from '../../src/operations/terminal-settlement';
import { createOperationPublication } from '../../src/operations/publication';
import type { WorkerOperationRequest, WorkerOperationState } from '../../src/operations/contracts';
import {
  JetStreamOperationEventStream,
  JetStreamOperationQueue,
  JetStreamOperationStateStore,
  hashOpKey,
  opEventsSubject,
  opIndexKvKey,
  opStateKvKey,
  type KvEntryLike,
  type KvStoreLike,
} from '../../src/infrastructure/nats-adapters';

class FakeKvStore implements KvStoreLike {
  private readonly data = new Map<string, KvEntryLike>();
  private revision = 0;

  async get(key: string): Promise<KvEntryLike | null> {
    const value = this.data.get(key);
    return value
      ? {
          operation: value.operation,
          value: value.value.slice(),
          revision: value.revision,
        }
      : null;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    this.revision += 1;
    this.data.set(key, { operation: 'PUT', value: data.slice(), revision: this.revision });
  }

  async create(key: string, data: Uint8Array): Promise<void> {
    if (this.data.has(key)) throw new Error('key exists');
    this.revision += 1;
    this.data.set(key, { operation: 'PUT', value: data.slice(), revision: this.revision });
  }

  async update(key: string, data: Uint8Array, version: number): Promise<void> {
    const current = this.data.get(key);
    if (!current || current.revision !== version) throw new Error('wrong last sequence');
    this.revision += 1;
    this.data.set(key, { operation: 'PUT', value: data.slice(), revision: this.revision });
  }

  async keys(_filter?: string | string[]): Promise<AsyncIterable<string>> {
    const prefix = typeof _filter === 'string' ? _filter.replace(/\*$/, '') : '';
    const keys = Array.from(this.data.keys()).filter((key) => key.startsWith(prefix));
    return {
      async *[Symbol.asyncIterator]() {
        for (const key of keys) {
          yield key;
        }
      }
    };
  }

  async delete(key: string, options?: { previousSeq: number }): Promise<void> {
    if (this.data.get(key)?.revision !== options?.previousSeq) throw new Error('wrong last sequence');
    this.data.delete(key);
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
    const payload = JSON.parse(new TextDecoder().decode(data));
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

describe('jetstream adapters', () => {
  test('retries a failed queue publication in a new process under the original job ID', async () => {
    const kv = new FakeKvStore();
    const js = new FakeJetStream();
    const stateStore = new JetStreamOperationStateStore({ getKv: async () => kv });
    const queue = new JetStreamOperationQueue({
      getJs: async () => js, layoutSubject: 'jobs.layout', ttsPlaybackSubject: 'jobs.tts_playback',
    });
    const enqueue = vi.spyOn(queue, 'enqueue').mockRejectedValueOnce(new Error('publish ack unavailable'));
    const beforePublish = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('session link unavailable'));
    const deps = { store: stateStore, queue, beforePublish, logger: { warn: vi.fn() }, maxAgeMs: 30_000, expire: vi.fn() };
    const orchestrator = new OperationOrchestrator({
      queue,
      stateStore,
      eventStream: new JetStreamOperationEventStream({
        getJs: async () => js as never,
        getJsm: async () => ({ consumers: {} }) as never,
        eventsStreamName: 'events',
      }),
      config: { opStaleMs: 30_000 },
      publication: createOperationPublication(deps),
    });
    const request = buildPdfRequest('durable-publication');
    const operation = await orchestrator.enqueueOrReuse(request);
    expect(await orchestrator.enqueueOrReuse(request)).toEqual(operation);
    expect(js.published).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();

    const replacement = createOperationPublication(deps);
    await expect(replacement.drain()).resolves.toBe(true);
    expect(js.published).toHaveLength(0);
    await expect(replacement.drain()).resolves.toBe(true);
    expect(beforePublish).toHaveBeenCalledTimes(3);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(js.published[0]?.payload).toMatchObject({ opId: operation.opId, jobId: operation.jobId });
    expect(await stateStore.getPublication(operation.opId)).toBeNull();
    await expect(replacement.drain()).resolves.toBe(false);
  });

  test('a new process retries terminal settlement after the broker was unavailable', async () => {
    const kv = new FakeKvStore();
    const js = new FakeJetStream();
    const stateStore = new JetStreamOperationStateStore({ getKv: async () => kv });
    const eventStream = new JetStreamOperationEventStream({
      getJs: async () => js as never,
      getJsm: async () => ({ consumers: {} }) as never,
      eventsStreamName: 'events',
    });
    const notify = vi.fn()
      .mockRejectedValueOnce(new Error('broker unavailable'))
      .mockResolvedValue(undefined);
    const deps = {
      store: stateStore,
      publish: (state: WorkerOperationState) => eventStream.append(state.opId, state),
      notify,
      logger: { warn: vi.fn() },
    };
    const first = createTerminalSettlement(deps);
    const orchestrator = new OperationOrchestrator({
      queue: new JetStreamOperationQueue({
        getJs: async () => js, layoutSubject: 'jobs.layout', ttsPlaybackSubject: 'jobs.tts_playback',
      }),
      stateStore,
      eventStream,
      config: { opStaleMs: 30_000 },
      terminalSettlement: first,
    });
    const { opId, jobId } = await orchestrator.enqueueOrReuse(buildPdfRequest('durable-completion'));
    const attempt = { opId, jobId, deliveryAttempt: 1, updatedAt: Date.now() };
    await orchestrator.claimAttempt(attempt);
    await orchestrator.settleAttempt({ ...attempt, status: 'succeeded', result: { parsedObjectKey: 'parsed.json' } });

    await expect(first.flush(opId)).rejects.toThrow('broker unavailable');
    expect(await stateStore.getTerminalSettlement(opId)).not.toBeNull();
    expect((await stateStore.getOpState(opId))?.status).toBe('succeeded');

    const replacement = createTerminalSettlement(deps);
    await expect(replacement.drain()).resolves.toBe(true);
    expect(notify).toHaveBeenLastCalledWith({ operationId: opId, state: 'succeeded' }, expect.objectContaining({ opId }));
    expect(await stateStore.getTerminalSettlement(opId)).toBeNull();
    await expect(replacement.drain()).resolves.toBe(false);

    // Another worker can drain the marker before the cache invalidation CAS.
    const previous = (await stateStore.getOpStateRecord(opId))!;
    await first.track(opId, previous.revision);
    await replacement.flush(opId);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(await stateStore.getTerminalSettlement(opId)).not.toBeNull();
    await orchestrator.markFailedIfUnchanged({
      current: previous.state, expectedRevision: previous.revision, error: 'Playback cache cleared',
    });
    await replacement.flush(opId);
    expect(notify).toHaveBeenLastCalledWith({ operationId: opId, state: 'failed' }, expect.objectContaining({ opId }));
    expect(await stateStore.getTerminalSettlement(opId)).toBeNull();
  });

  test('replays a completion published between the initial state read and subscription', async () => {
    let policy: unknown;
    const terminal = { opId: 'op-gap', status: 'succeeded', updatedAt: 2 };
    const onEvent = vi.fn();
    const add = vi.fn(async (_stream: string, config: { deliver_policy: unknown }) => {
      policy = config.deliver_policy;
    });
    const events = new JetStreamOperationEventStream({
      getJsm: async () => ({ consumers: { add, delete: async () => true } }) as never,
      getJs: async () => ({ consumers: { get: async () => ({ consume: async () => ({
        close: async () => undefined,
        async *[Symbol.asyncIterator]() {
          // This event already exists when the consumer is created, so a
          // new-only subscription cannot see it and would remain pending.
          if (policy === DeliverPolicy.Last) {
            yield { seq: 9, data: new TextEncoder().encode(JSON.stringify(terminal)) };
          }
        },
      }) }) } }) as never,
      eventsStreamName: 'events',
    });
    const stop = await events.subscribe({ opId: 'op-gap', onEvent });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith({ eventId: 9, snapshot: terminal }));
    expect(add).toHaveBeenCalledWith('events', expect.objectContaining({
      deliver_policy: DeliverPolicy.Last, filter_subject: opEventsSubject('op-gap'),
    }));
    stop();
    await events.subscribe({ opId: 'op-gap', sinceEventId: 9, onEvent });
    expect(add).toHaveBeenLastCalledWith('events', expect.objectContaining({
      deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: 10,
    }));
  });

  test('reads historical operation states with bounded parallelism', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maximum = 0;
    class SlowKvStore extends FakeKvStore {
      override async get(key: string) {
        active++;
        maximum = Math.max(maximum, active);
        await gate;
        active--;
        return super.get(key);
      }
    }
    const kv = new SlowKvStore();
    for (let i = 0; i < 40; i++) {
      await kv.put(opStateKvKey(`op-${i}`), new TextEncoder().encode(JSON.stringify({ opId: `op-${i}` })));
    }
    const store = new JetStreamOperationStateStore({ getKv: async () => kv });
    const read = store.listOpStates();
    await vi.waitFor(() => expect(active).toBe(32));
    release();
    expect(await read).toHaveLength(40);
    expect(maximum).toBe(32);
  });

  test('state store compareAndSet enforces create/update semantics', async () => {
    const kv = new FakeKvStore();
    const store = new JetStreamOperationStateStore({ getKv: async () => kv });

    const created = await store.compareAndSetOpIndex({ opKey: 'k1', newOpId: 'op-1', expectedOpId: null });
    const duplicateCreate = await store.compareAndSetOpIndex({ opKey: 'k1', newOpId: 'op-2', expectedOpId: null });
    const wrongExpected = await store.compareAndSetOpIndex({ opKey: 'k1', newOpId: 'op-2', expectedOpId: 'op-x' });
    const updated = await store.compareAndSetOpIndex({ opKey: 'k1', newOpId: 'op-2', expectedOpId: 'op-1' });

    expect(created).toBe(true);
    expect(duplicateCreate).toBe(false);
    expect(wrongExpected).toBe(false);
    expect(updated).toBe(true);
    expect(await store.getOpIndex('k1')).toEqual({ opId: 'op-2' });
  });

  test('queue routes layout jobs to the expected subject and publishes events', async () => {
    const js = new FakeJetStream();
    const queue = new JetStreamOperationQueue({
      getJs: async () => js as never,
      layoutSubject: 'jobs.layout',
      ttsPlaybackSubject: 'jobs.tts_playback',
      ttsPlaybackPlanSubject: 'jobs.tts_playback_plan',
    });
    const events = new JetStreamOperationEventStream({
      getJs: async () => js as never,
      getJsm: async () => ({
        consumers: {
          add: async () => ({ name: 'noop' }),
          delete: async () => true,
        },
      }) as never,
      eventsStreamName: 'compute_events',
    });

    await queue.enqueue({
      jobId: 'job-1',
      opId: 'op-1',
      opKey: 'k-1',
      kind: 'pdf_layout',
      queuedAt: 1000,
      payload: { documentId: 'd1', namespace: null, documentObjectKey: 'obj' },
    });

    const appended = await events.append('op-1', {
      opId: 'op-1',
      opKey: 'k-1',
      kind: 'pdf_layout',
      jobId: 'job-1',
      status: 'queued',
      queuedAt: 1000,
      updatedAt: 1000,
    });

    expect(js.published.map((entry) => entry.subject)).toEqual(['jobs.layout', opEventsSubject('op-1')]);
    expect(appended.eventId).toBe(2);
  });

  test('queue routes whole-document playback runs to their own subject', async () => {
    const js = new FakeJetStream();
    const queue = new JetStreamOperationQueue({
      getJs: async () => js as never,
      layoutSubject: 'jobs.layout',
      ttsPlaybackSubject: 'jobs.tts_playback',
      ttsPlaybackDocumentSubject: 'jobs.tts_playback_document',
    });
    const job = (opId: string, generationExtent?: 'document') => ({
      jobId: `job-${opId}`,
      opId,
      opKey: `k-${opId}`,
      kind: 'tts_playback' as const,
      queuedAt: 1000,
      payload: { sessionId: opId, ...(generationExtent ? { generationExtent } : {}) } as never,
    });

    await queue.enqueue(job('live'));
    await queue.enqueue(job('export', 'document'));

    expect(js.published.map((entry) => entry.subject)).toEqual([
      'jobs.tts_playback',
      'jobs.tts_playback_document',
    ]);
  });

  test('queue routes playback plan jobs to the isolated subject', async () => {
    const js = new FakeJetStream();
    const queue = new JetStreamOperationQueue({
      getJs: async () => js as never,
      layoutSubject: 'jobs.layout',
      ttsPlaybackSubject: 'jobs.tts_playback',
      ttsPlaybackPlanSubject: 'jobs.tts_playback_plan',
    });

    await queue.enqueue({
      jobId: 'job-plan',
      opId: 'op-plan',
      opKey: 'k-plan',
      kind: 'tts_playback_plan',
      queuedAt: 1000,
      payload: {
        userId: 'u1',
        storageUserId: 'u1',
        documentId: 'd1',
        documentVersion: 1,
        readerType: 'pdf',
        settingsHash: 'settings',
        settingsJson: { nativeSpeed: 1 },
        planning: {},
      },
    });

    expect(js.published.map((entry) => entry.subject)).toEqual(['jobs.tts_playback_plan']);
  });

  test('orchestrator writes expected index/state keys', async () => {
    const kv = new FakeKvStore();
    const js = new FakeJetStream();

    const stateStore = new JetStreamOperationStateStore({ getKv: async () => kv });
    const eventStream = new JetStreamOperationEventStream({
      getJs: async () => js as never,
      getJsm: async () => ({
        consumers: {
          add: async () => ({ name: 'noop' }),
          delete: async () => true,
        },
      }) as never,
      eventsStreamName: 'compute_events',
    });
    const queue = new JetStreamOperationQueue({
      getJs: async () => js as never,
      layoutSubject: 'jobs.layout',
      ttsPlaybackSubject: 'jobs.tts_playback',
      ttsPlaybackPlanSubject: 'jobs.tts_playback_plan',
    });

    let now = 1_000;
    let nextId = 1;
    const orchestrator = new OperationOrchestrator({
      queue,
      stateStore,
      eventStream,
      config: { opStaleMs: 10_000, maxCasRetries: 3 },
      clock: { now: () => now },
      idFactory: {
        opId: () => `op-${nextId}`,
        jobId: () => `job-${nextId++}`,
      },
    });

    const first = await orchestrator.enqueueOrReuse(buildPdfRequest('k-integration'));
    now = 2_000;
    const reused = await orchestrator.enqueueOrReuse(buildPdfRequest('k-integration'));

    expect(first.opId).toBe('op-1');
    expect(reused.opId).toBe('op-1');

    const indexEntry = await kv.get(opIndexKvKey('k-integration'));
    const stateEntry = await kv.get(opStateKvKey('op-1'));

    expect(indexEntry?.operation).toBe('PUT');
    expect(stateEntry?.operation).toBe('PUT');
    expect(hashOpKey('k-integration')).toHaveLength(64);
  });
});

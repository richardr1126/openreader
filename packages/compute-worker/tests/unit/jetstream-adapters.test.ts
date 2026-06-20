import { describe, expect, test } from 'vitest';
import { OperationOrchestrator } from '../../src/operations';
import type { WorkerOperationRequest } from '../../src/operations/contracts';
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

  async keys(filter?: string | string[]): Promise<AsyncIterable<string>> {
    const keys = Array.from(this.data.keys());
    return {
      async *[Symbol.asyncIterator]() {
        for (const key of keys) {
          yield key;
        }
      }
    };
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
        startOrdinal: 0,
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

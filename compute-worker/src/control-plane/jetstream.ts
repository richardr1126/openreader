import { createHash } from 'node:crypto';
import { AckPolicy, DeliverPolicy, ReplayPolicy, type JetStreamClient, type JetStreamManager } from '@nats-io/jetstream';
import { nanos } from '@nats-io/transport-node';
import type {
  OperationEvent,
  OperationEventStream,
  OperationQueue,
  OperationState,
  OperationStateStore,
  QueuedOperation,
} from '../compute/control-plane';
import type {
  PdfLayoutJobRequest,
  WhisperAlignJobRequest,
  WorkerOperationKind,
} from '../compute/api-contracts';
import { createJsonCodec } from './json-codec';

export interface KvEntryLike {
  operation?: string;
  value: Uint8Array;
  revision: number;
}

export interface KvStoreLike {
  get(key: string): Promise<KvEntryLike | null>;
  put(key: string, data: Uint8Array): Promise<unknown>;
  create(key: string, data: Uint8Array): Promise<unknown>;
  update(key: string, data: Uint8Array, version: number): Promise<unknown>;
  keys(filter?: string | string[]): Promise<AsyncIterable<string>>;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function isCasConflictError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return message.includes('wrong last sequence') || message.includes('key exists') || message.includes('wrong last');
}

function isPut(entry: KvEntryLike | null): entry is KvEntryLike {
  return Boolean(entry && entry.operation === 'PUT');
}

interface OpIndexEntry {
  opId: string;
}

export const OP_EVENTS_SUBJECT_PREFIX = 'ops.events';
export const OP_EVENTS_SUBJECT_WILDCARD = `${OP_EVENTS_SUBJECT_PREFIX}.*`;

export function hashOpKey(opKey: string): string {
  return createHash('sha256').update(opKey).digest('hex');
}

export function opIndexKvKey(opKey: string): string {
  return `op_index.${hashOpKey(opKey)}`;
}

export function opStateKvKey(opId: string): string {
  return `op_state.${opId}`;
}

export function opEventsSubject(opId: string): string {
  return `${OP_EVENTS_SUBJECT_PREFIX}.${opId}`;
}

export interface JetStreamOperationStateStoreDeps {
  getKv: () => Promise<KvStoreLike>;
}

export class JetStreamOperationStateStore<Result = unknown> implements OperationStateStore<Result> {
  private readonly getKv: () => Promise<KvStoreLike>;
  private readonly opStateCodec = createJsonCodec<OperationState<Result>>();
  private readonly opIndexCodec = createJsonCodec<OpIndexEntry>();

  constructor(deps: JetStreamOperationStateStoreDeps) {
    this.getKv = deps.getKv;
  }

  async getOpState(opId: string): Promise<OperationState<Result> | null> {
    const record = await this.getOpStateRecord(opId);
    return record?.state ?? null;
  }

  async getOpStateRecord(opId: string): Promise<{ state: OperationState<Result>; revision: number } | null> {
    const kv = await this.getKv();
    const entry = await kv.get(opStateKvKey(opId));
    if (!isPut(entry)) return null;
    return {
      state: this.opStateCodec.decode(entry.value),
      revision: entry.revision,
    };
  }

  async putOpState(state: OperationState<Result>): Promise<void> {
    const kv = await this.getKv();
    await kv.put(opStateKvKey(state.opId), this.opStateCodec.encode(state));
  }

  async compareAndSetOpState(input: {
    opId: string;
    expectedRevision: number;
    newState: OperationState<Result>;
  }): Promise<boolean> {
    const kv = await this.getKv();
    try {
      await kv.update(
        opStateKvKey(input.opId),
        this.opStateCodec.encode(input.newState),
        input.expectedRevision,
      );
      return true;
    } catch (error) {
      if (isCasConflictError(error)) return false;
      throw error;
    }
  }

  async listOpStates(): Promise<OperationState<Result>[]> {
    const kv = await this.getKv();
    const keys = await kv.keys('op_state.*');
    const states: OperationState<Result>[] = [];
    for await (const key of keys) {
      const entry = await kv.get(key);
      if (!isPut(entry)) continue;
      states.push(this.opStateCodec.decode(entry.value));
    }
    return states;
  }

  async getOpIndex(opKey: string): Promise<{ opId: string } | null> {
    const kv = await this.getKv();
    const entry = await kv.get(opIndexKvKey(opKey));
    if (!isPut(entry)) return null;
    return this.opIndexCodec.decode(entry.value);
  }

  async compareAndSetOpIndex(input: {
    opKey: string;
    newOpId: string;
    expectedOpId: string | null;
  }): Promise<boolean> {
    const kv = await this.getKv();
    const key = opIndexKvKey(input.opKey);
    const value = this.opIndexCodec.encode({ opId: input.newOpId });

    if (input.expectedOpId === null) {
      try {
        await kv.create(key, value);
        return true;
      } catch (error) {
        if (isCasConflictError(error)) return false;
        throw error;
      }
    }

    const current = await kv.get(key);
    if (!isPut(current)) return false;
    const decoded = this.opIndexCodec.decode(current.value);
    if (decoded.opId !== input.expectedOpId) return false;

    try {
      await kv.update(key, value, current.revision);
      return true;
    } catch (error) {
      if (isCasConflictError(error)) return false;
      throw error;
    }
  }
}

export interface JetStreamOperationEventStreamDeps {
  getJs: () => Promise<Pick<JetStreamClient, 'publish' | 'consumers'>>;
  getJsm: () => Promise<Pick<JetStreamManager, 'consumers'>>;
  eventsStreamName: string;
  inactiveThresholdMs?: number;
}

export class JetStreamOperationEventStream<Result = unknown> implements OperationEventStream<Result> {
  private readonly getJs: () => Promise<Pick<JetStreamClient, 'publish' | 'consumers'>>;
  private readonly getJsm: () => Promise<Pick<JetStreamManager, 'consumers'>>;
  private readonly eventsStreamName: string;
  private readonly inactiveThresholdNanos: number;
  private readonly opStateCodec = createJsonCodec<OperationState<Result>>();

  constructor(deps: JetStreamOperationEventStreamDeps) {
    this.getJs = deps.getJs;
    this.getJsm = deps.getJsm;
    this.eventsStreamName = deps.eventsStreamName;
    this.inactiveThresholdNanos = nanos((deps.inactiveThresholdMs ?? 60_000));
  }

  async append(opId: string, snapshot: OperationState<Result>): Promise<OperationEvent<Result>> {
    const js = await this.getJs();
    const encoder = new TextEncoder();
    const ack = await js.publish(opEventsSubject(opId), encoder.encode(JSON.stringify(snapshot)));
    return {
      eventId: ack.seq,
      snapshot,
    };
  }

  private async createConsumer(input: {
    opId: string;
    sinceEventId?: number;
    replayOnly: boolean;
  }): Promise<{ name: string; js: Pick<JetStreamClient, 'publish' | 'consumers'> }> {
    const js = await this.getJs();
    const jsm = await this.getJsm();
    const subject = opEventsSubject(input.opId);
    const since = Math.max(0, Math.floor(input.sinceEventId ?? 0));
    const name = `op_events_${input.opId.slice(0, 12)}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const config = {
      name,
      ack_policy: AckPolicy.None,
      deliver_policy: since > 0 ? DeliverPolicy.StartSequence : (input.replayOnly ? DeliverPolicy.All : DeliverPolicy.New),
      replay_policy: ReplayPolicy.Instant,
      filter_subject: subject,
      max_deliver: 1,
      inactive_threshold: this.inactiveThresholdNanos,
      ...(since > 0 ? { opt_start_seq: since + 1 } : {}),
    };
    await jsm.consumers.add(this.eventsStreamName, config);
    return { name, js };
  }

  private async deleteConsumer(name: string): Promise<void> {
    const jsm = await this.getJsm();
    await jsm.consumers.delete(this.eventsStreamName, name).catch(() => undefined);
  }

  async listSince(opId: string, sinceEventId: number, limit = 200): Promise<OperationEvent<Result>[]> {
    const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 200;
    const { name, js } = await this.createConsumer({
      opId,
      sinceEventId,
      replayOnly: true,
    });
    try {
      const consumer = await js.consumers.get(this.eventsStreamName, name);
      const output: OperationEvent<Result>[] = [];
      while (output.length < boundedLimit) {
        const msg = await consumer.next({ expires: 250 });
        if (!msg) break;
        output.push({
          eventId: msg.seq,
          snapshot: this.opStateCodec.decode(msg.data),
        });
      }
      return output;
    } finally {
      await this.deleteConsumer(name);
    }
  }

  async subscribe(input: {
    opId: string;
    sinceEventId?: number;
    onEvent: (event: OperationEvent<Result>) => void | Promise<void>;
    onError?: (error: unknown) => void;
  }): Promise<() => void> {
    const { name, js } = await this.createConsumer({
      opId: input.opId,
      sinceEventId: input.sinceEventId,
      replayOnly: false,
    });
    const consumer = await js.consumers.get(this.eventsStreamName, name);
    const messages = await consumer.consume();
    let closed = false;

    void (async () => {
      try {
        for await (const msg of messages) {
          if (closed) break;
          try {
            await input.onEvent({
              eventId: msg.seq,
              snapshot: this.opStateCodec.decode(msg.data),
            });
          } catch (error) {
            input.onError?.(error);
          }
        }
      } catch (error) {
        if (!closed) input.onError?.(error);
      } finally {
        if (!closed) {
          closed = true;
          await this.deleteConsumer(name);
        }
      }
    })();

    return () => {
      if (closed) return;
      closed = true;
      void messages.close().catch(() => undefined);
      void this.deleteConsumer(name);
    };
  }
}

export interface JetStreamOperationQueueDeps<TPayload> {
  getJs: () => Promise<Pick<JetStreamClient, 'publish'>>;
  whisperSubject: string;
  layoutSubject: string;
  onEnqueued?: (job: QueuedOperation<TPayload>) => Promise<void> | void;
}

export class JetStreamOperationQueue implements OperationQueue<WhisperAlignJobRequest | PdfLayoutJobRequest> {
  private readonly getJs: () => Promise<Pick<JetStreamClient, 'publish'>>;
  private readonly whisperSubject: string;
  private readonly layoutSubject: string;
  private readonly onEnqueued?: (job: QueuedOperation<WhisperAlignJobRequest | PdfLayoutJobRequest>) => Promise<void> | void;
  private readonly whisperCodec = createJsonCodec<QueuedOperation<WhisperAlignJobRequest>>();
  private readonly layoutCodec = createJsonCodec<QueuedOperation<PdfLayoutJobRequest>>();

  constructor(deps: JetStreamOperationQueueDeps<WhisperAlignJobRequest | PdfLayoutJobRequest>) {
    this.getJs = deps.getJs;
    this.whisperSubject = deps.whisperSubject;
    this.layoutSubject = deps.layoutSubject;
    this.onEnqueued = deps.onEnqueued;
  }

  async enqueue(job: QueuedOperation<WhisperAlignJobRequest | PdfLayoutJobRequest>): Promise<void> {
    const js = await this.getJs();
    if (job.kind === 'whisper_align') {
      await js.publish(
        this.whisperSubject,
        this.whisperCodec.encode(job as QueuedOperation<WhisperAlignJobRequest>),
      );
    } else if (job.kind === 'pdf_layout') {
      await js.publish(
        this.layoutSubject,
        this.layoutCodec.encode(job as QueuedOperation<PdfLayoutJobRequest>),
      );
    } else {
      const exhaustive: never = job.kind;
      throw new Error(`Unsupported operation kind: ${String(exhaustive)}`);
    }

    await this.onEnqueued?.(job);
  }

  async claimNext(_kind: WorkerOperationKind): Promise<QueuedOperation<WhisperAlignJobRequest | PdfLayoutJobRequest> | null> {
    throw new Error('JetStreamOperationQueue.claimNext is not used by the worker runtime');
  }

  size(): number {
    return 0;
  }
}

import { createHash } from 'node:crypto';
import { AckPolicy, DeliverPolicy, ReplayPolicy, type JetStreamClient, type JetStreamManager } from '@nats-io/jetstream';
import type { KV } from '@nats-io/kv';
import { nanos } from '@nats-io/transport-node';
import type {
  OperationEvent,
  OperationEventStream,
  OperationQueue,
  OperationState,
  OperationStateStore,
  QueuedOperation,
} from '../operations/types';
import type {
  AccountExportJobRequest,
  EmailDeliveryJobRequest,
  ModelDownloadJobRequest,
  DocumentPreviewJobRequest,
  DocumentConversionJobRequest,
  PdfLayoutJobRequest,
  TtsPlaybackExportArtifactRequest,
  TtsPlaybackPlanJobRequest,
  TtsPlaybackJobRequest,
  WorkerOperationKind,
} from '../operations/contracts';
import { createJsonCodec } from './json-codec';
import { toErrorMessage } from './errors';
import type { MaintenanceJobRequest } from '../operations/contracts';
import type { PendingTerminalSettlement } from '../operations/terminal-settlement';
import type { PendingOperationPublication } from '../operations/publication';

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
  delete?(key: string, options?: { previousSeq: number }): Promise<void>;
  watch?: KV['watch'];
}

export function isKvCasConflictError(error: unknown): boolean {
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

const TERMINAL_SETTLEMENT_PREFIX = 'op_terminal_pending.';
const OP_PUBLICATION_PREFIX = 'op_publication.';
const terminalSettlementMarker = new Uint8Array();

export function opEventsSubject(opId: string): string {
  return `${OP_EVENTS_SUBJECT_PREFIX}.${opId}`;
}

export interface JetStreamOperationStateStoreDeps {
  getKv: () => Promise<KvStoreLike>;
  listKeys?: (filter: string) => AsyncIterable<string>;
}

export class JetStreamOperationStateStore<Result = unknown> implements OperationStateStore<Result> {
  private readonly getKv: () => Promise<KvStoreLike>;
  private readonly listKeys: (filter: string) => AsyncIterable<string>;
  private readonly opStateCodec = createJsonCodec<OperationState<Result>>();
  private readonly opIndexCodec = createJsonCodec<OpIndexEntry>();
  private readonly publicationCodec = createJsonCodec<QueuedOperation>();

  constructor(deps: JetStreamOperationStateStoreDeps) {
    this.getKv = deps.getKv;
    this.listKeys = deps.listKeys ?? (async function* (filter) {
      for await (const key of await (await deps.getKv()).keys(filter)) yield key;
    });
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
      if (isKvCasConflictError(error)) return false;
      throw error;
    }
  }

  async listOpStates(): Promise<OperationState<Result>[]> {
    const kv = await this.getKv();
    const keys: string[] = [];
    for await (const key of this.listKeys('op_state.*')) keys.push(key);
    const states: OperationState<Result>[] = [];
    // Remote NATS round trips dominate this scan in production. Bound the
    // fan-out instead of serializing every historical operation read.
    for (let index = 0; index < keys.length; index += 32) {
      const entries = await Promise.all(keys.slice(index, index + 32).map((key) => kv.get(key)));
      for (const entry of entries) {
        if (isPut(entry)) states.push(this.opStateCodec.decode(entry.value));
      }
    }
    return states;
  }


  async trackTerminalSettlement(opId: string): Promise<void> {
    const kv = await this.getKv();
    try {
      await kv.create(TERMINAL_SETTLEMENT_PREFIX + opId, terminalSettlementMarker);
    } catch (error) {
      if (!isKvCasConflictError(error)) throw error;
    }
  }

  async getTerminalSettlement(opId: string): Promise<PendingTerminalSettlement | null> {
    const entry = await (await this.getKv()).get(TERMINAL_SETTLEMENT_PREFIX + opId);
    return isPut(entry) ? { opId, revision: entry.revision } : null;
  }

  async listTerminalSettlements(limit: number): Promise<PendingTerminalSettlement[]> {
    return this.listPending(TERMINAL_SETTLEMENT_PREFIX, limit, (opId) => this.getTerminalSettlement(opId));
  }

  async finishTerminalSettlement(pending: PendingTerminalSettlement): Promise<void> {
    await this.deletePending(TERMINAL_SETTLEMENT_PREFIX + pending.opId, pending.revision);
  }

  private async deletePending(key: string, revision: number): Promise<void> {
    const kv = await this.getKv();
    if (!kv.delete) throw new Error('KV store does not support deleting terminal settlement markers');
    try {
      await kv.delete(key, { previousSeq: revision });
    } catch (error) {
      if (!isKvCasConflictError(error)) throw error;
    }
  }

  async stagePublication(job: QueuedOperation): Promise<void> {
    const kv = await this.getKv();
    await kv.create(OP_PUBLICATION_PREFIX + job.opId, this.publicationCodec.encode(job));
  }

  async getPublication(opId: string): Promise<PendingOperationPublication | null> {
    const entry = await (await this.getKv()).get(OP_PUBLICATION_PREFIX + opId);
    return isPut(entry) ? { job: this.publicationCodec.decode(entry.value), revision: entry.revision } : null;
  }

  async listPublications(limit: number): Promise<PendingOperationPublication[]> {
    return this.listPending(OP_PUBLICATION_PREFIX, limit, (opId) => this.getPublication(opId));
  }

  async deferPublication(pending: PendingOperationPublication): Promise<void> {
    const kv = await this.getKv();
    try {
      await kv.update(OP_PUBLICATION_PREFIX + pending.job.opId, this.publicationCodec.encode(pending.job), pending.revision);
    } catch (error) {
      if (!isKvCasConflictError(error)) throw error;
    }
  }

  async finishPublication(opId: string, revision: number): Promise<void> {
    await this.deletePending(OP_PUBLICATION_PREFIX + opId, revision);
  }

  private async listPending<T>(prefix: string, limit: number, get: (opId: string) => Promise<T | null>): Promise<T[]> {
    const pending: T[] = [];
    for await (const key of this.listKeys(prefix + '*')) {
      const entry = await get(key.slice(prefix.length));
      if (entry) pending.push(entry);
      if (pending.length >= limit) break;
    }
    return pending;
  }

  async deferTerminalSettlement(pending: PendingTerminalSettlement): Promise<void> {
    const kv = await this.getKv();
    try {
      // Updating the marker moves it behind the other pending settlements.
      await kv.update(TERMINAL_SETTLEMENT_PREFIX + pending.opId, terminalSettlementMarker, pending.revision);
    } catch (error) {
      if (!isKvCasConflictError(error)) throw error;
    }
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
        if (isKvCasConflictError(error)) return false;
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
      if (isKvCasConflictError(error)) return false;
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
    const ack = await js.publish(opEventsSubject(opId), encoder.encode(JSON.stringify(snapshot)),
      snapshot.status === 'succeeded' || snapshot.status === 'failed'
        ? { msgID: `${opId}:${snapshot.status}:${snapshot.updatedAt}` } : undefined);
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
      // The HTTP route reads its initial snapshot before creating this
      // consumer. Replay the latest event for this subject to cover a job
      // finishing in that gap; New would lose the terminal update forever.
      deliver_policy: since > 0 ? DeliverPolicy.StartSequence : (input.replayOnly ? DeliverPolicy.All : DeliverPolicy.Last),
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
        const msg = await consumer.next({ expires: 1_000 });
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
  layoutSubject: string;
  ttsPlaybackSubject: string;
  ttsPlaybackDocumentSubject?: string;
  ttsPlaybackPlanSubject?: string;
  ttsPlaybackExportSubject?: string;
  documentPreviewSubject?: string;
  documentConversionSubject?: string;
  accountExportSubject?: string;
  emailDeliverySubject?: string;
  modelDownloadSubject?: string;
  maintenanceSubject?: string;
  onEnqueued?: (job: QueuedOperation<TPayload>) => Promise<void> | void;
}

type JetStreamQueuedPayload =
  | PdfLayoutJobRequest
  | TtsPlaybackJobRequest
  | TtsPlaybackPlanJobRequest
  | TtsPlaybackExportArtifactRequest
  | DocumentPreviewJobRequest
  | DocumentConversionJobRequest
  | AccountExportJobRequest
  | EmailDeliveryJobRequest
  | ModelDownloadJobRequest
  | MaintenanceJobRequest;

export class JetStreamOperationQueue implements OperationQueue<JetStreamQueuedPayload> {
  private readonly getJs: () => Promise<Pick<JetStreamClient, 'publish'>>;
  private readonly layoutSubject: string;
  private readonly ttsPlaybackSubject: string;
  private readonly ttsPlaybackDocumentSubject: string;
  private readonly ttsPlaybackPlanSubject: string;
  private readonly ttsPlaybackExportSubject: string;
  private readonly documentPreviewSubject: string;
  private readonly documentConversionSubject: string;
  private readonly accountExportSubject: string;
  private readonly emailDeliverySubject: string;
  private readonly modelDownloadSubject: string;
  private readonly maintenanceSubject: string;
  private readonly maintenanceCodec = createJsonCodec<QueuedOperation<MaintenanceJobRequest>>();
  private readonly onEnqueued?: (job: QueuedOperation<JetStreamQueuedPayload>) => Promise<void> | void;
  private readonly layoutCodec = createJsonCodec<QueuedOperation<PdfLayoutJobRequest>>();
  private readonly ttsPlaybackCodec = createJsonCodec<QueuedOperation<TtsPlaybackJobRequest>>();
  private readonly ttsPlaybackPlanCodec = createJsonCodec<QueuedOperation<TtsPlaybackPlanJobRequest>>();
  private readonly ttsPlaybackExportCodec = createJsonCodec<QueuedOperation<TtsPlaybackExportArtifactRequest>>();
  private readonly documentPreviewCodec = createJsonCodec<QueuedOperation<DocumentPreviewJobRequest>>();
  private readonly documentConversionCodec = createJsonCodec<QueuedOperation<DocumentConversionJobRequest>>();
  private readonly accountExportCodec = createJsonCodec<QueuedOperation<AccountExportJobRequest>>();
  private readonly emailDeliveryCodec = createJsonCodec<QueuedOperation<EmailDeliveryJobRequest>>();
  private readonly modelDownloadCodec = createJsonCodec<QueuedOperation<ModelDownloadJobRequest>>();

  constructor(deps: JetStreamOperationQueueDeps<JetStreamQueuedPayload>) {
    this.getJs = deps.getJs;
    this.layoutSubject = deps.layoutSubject;
    this.ttsPlaybackSubject = deps.ttsPlaybackSubject;
    this.ttsPlaybackDocumentSubject = deps.ttsPlaybackDocumentSubject ?? 'jobs.tts_playback_document';
    this.ttsPlaybackPlanSubject = deps.ttsPlaybackPlanSubject ?? 'jobs.tts_playback_plan';
    this.ttsPlaybackExportSubject = deps.ttsPlaybackExportSubject ?? 'jobs.tts_playback_export';
    this.documentPreviewSubject = deps.documentPreviewSubject ?? 'jobs.document_preview';
    this.documentConversionSubject = deps.documentConversionSubject ?? 'jobs.document_conversion';
    this.accountExportSubject = deps.accountExportSubject ?? 'jobs.account_export';
    this.emailDeliverySubject = deps.emailDeliverySubject ?? 'jobs.email_delivery';
    this.modelDownloadSubject = deps.modelDownloadSubject ?? 'jobs.model_download';
    this.maintenanceSubject = deps.maintenanceSubject ?? 'jobs.maintenance';
    this.onEnqueued = deps.onEnqueued;
  }

  async enqueue(job: QueuedOperation<JetStreamQueuedPayload>): Promise<void> {
    const js = await this.getJs();
    const options = { msgID: job.jobId };
    if (job.kind === 'pdf_layout') {
      await js.publish(
        this.layoutSubject,
        this.layoutCodec.encode(job as QueuedOperation<PdfLayoutJobRequest>),
        options,
      );
    } else if (job.kind === 'tts_playback') {
      // Whole-document runs have their own consumer so hours-long exports
      // queue among themselves instead of occupying live playback pullers.
      const payload = job.payload as TtsPlaybackJobRequest;
      await js.publish(
        payload.generationExtent === 'document' ? this.ttsPlaybackDocumentSubject : this.ttsPlaybackSubject,
        this.ttsPlaybackCodec.encode(job as QueuedOperation<TtsPlaybackJobRequest>),
        options,
      );
    } else if (job.kind === 'tts_playback_plan') {
      await js.publish(
        this.ttsPlaybackPlanSubject,
        this.ttsPlaybackPlanCodec.encode(job as QueuedOperation<TtsPlaybackPlanJobRequest>),
        options,
      );
    } else if (job.kind === 'tts_playback_export') {
      await js.publish(
        this.ttsPlaybackExportSubject,
        this.ttsPlaybackExportCodec.encode(job as QueuedOperation<TtsPlaybackExportArtifactRequest>),
        options,
      );
    } else if (job.kind === 'document_preview') {
      await js.publish(
        this.documentPreviewSubject,
        this.documentPreviewCodec.encode(job as QueuedOperation<DocumentPreviewJobRequest>),
        options,
      );
    } else if (job.kind === 'document_conversion') {
      await js.publish(
        this.documentConversionSubject,
        this.documentConversionCodec.encode(job as QueuedOperation<DocumentConversionJobRequest>),
        options,
      );
    } else if (job.kind === 'account_export') {
      await js.publish(
        this.accountExportSubject,
        this.accountExportCodec.encode(job as QueuedOperation<AccountExportJobRequest>),
        options,
      );
    } else if (job.kind === 'email_delivery') {
      await js.publish(
        this.emailDeliverySubject,
        this.emailDeliveryCodec.encode(job as QueuedOperation<EmailDeliveryJobRequest>),
        options,
      );
    } else if (job.kind === 'model_download') {
      await js.publish(
        this.modelDownloadSubject,
        this.modelDownloadCodec.encode(job as QueuedOperation<ModelDownloadJobRequest>),
        options,
      );
    } else if (job.kind === 'maintenance') {
      await js.publish(this.maintenanceSubject, this.maintenanceCodec.encode(job as QueuedOperation<MaintenanceJobRequest>), options);
    } else {
      const exhaustive: never = job.kind;
      throw new Error(`Unsupported operation kind: ${String(exhaustive)}`);
    }

    await this.onEnqueued?.(job);
  }

  async claimNext(_kind: WorkerOperationKind): Promise<QueuedOperation<JetStreamQueuedPayload> | null> {
    throw new Error('JetStreamOperationQueue.claimNext is not used by the worker runtime');
  }

  size(): number {
    return 0;
  }
}

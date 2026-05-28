import { EventEmitter } from 'node:events';
import type {
  OperationEvent,
  OperationEventStream,
  OperationIndexEntry,
  OperationQueue,
  OperationState,
  OperationStateStore,
  QueuedOperation,
} from './types';
import type { WorkerOperationKind } from '../api-contracts';

function topicFor(opId: string): string {
  return `op.${opId}`;
}

function normalizeSinceEventId(value: number | undefined): number {
  if (!Number.isFinite(value ?? 0)) return 0;
  return Math.max(0, Math.floor(value ?? 0));
}

export class InMemoryOperationQueue implements OperationQueue {
  private readonly byKind = new Map<WorkerOperationKind, QueuedOperation[]>();

  constructor() {
    this.byKind.set('whisper_align', []);
    this.byKind.set('pdf_layout', []);
  }

  async enqueue(job: QueuedOperation): Promise<void> {
    const list = this.byKind.get(job.kind);
    if (!list) throw new Error(`Unsupported operation kind: ${job.kind}`);
    list.push(job);
  }

  async claimNext(kind: WorkerOperationKind): Promise<QueuedOperation | null> {
    const list = this.byKind.get(kind);
    if (!list || list.length === 0) return null;
    return list.shift() ?? null;
  }

  size(kind?: WorkerOperationKind): number {
    if (kind) return this.byKind.get(kind)?.length ?? 0;
    let total = 0;
    for (const list of this.byKind.values()) total += list.length;
    return total;
  }
}

export class InMemoryOperationStateStore implements OperationStateStore {
  private readonly stateByOpId = new Map<string, OperationState>();
  private readonly opIndexByKey = new Map<string, string>();

  async getOpState(opId: string): Promise<OperationState | null> {
    return this.stateByOpId.get(opId) ?? null;
  }

  async putOpState(state: OperationState): Promise<void> {
    this.stateByOpId.set(state.opId, state);
  }

  async getOpIndex(opKey: string): Promise<OperationIndexEntry | null> {
    const opId = this.opIndexByKey.get(opKey);
    return opId ? { opId } : null;
  }

  async compareAndSetOpIndex(input: {
    opKey: string;
    newOpId: string;
    expectedOpId: string | null;
  }): Promise<boolean> {
    const current = this.opIndexByKey.get(input.opKey) ?? null;
    if (current !== input.expectedOpId) return false;
    this.opIndexByKey.set(input.opKey, input.newOpId);
    return true;
  }
}

export class InMemoryOperationEventStream implements OperationEventStream {
  private readonly emitter = new EventEmitter();
  private readonly lastIdByOpId = new Map<string, number>();
  private readonly eventsByOpId = new Map<string, OperationEvent[]>();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  async append(opId: string, snapshot: OperationState): Promise<OperationEvent> {
    const nextEventId = (this.lastIdByOpId.get(opId) ?? 0) + 1;
    this.lastIdByOpId.set(opId, nextEventId);

    const event: OperationEvent = {
      eventId: nextEventId,
      snapshot,
    };

    const list = this.eventsByOpId.get(opId) ?? [];
    list.push(event);
    this.eventsByOpId.set(opId, list);
    this.emitter.emit(topicFor(opId), event);
    return event;
  }

  async listSince(opId: string, sinceEventId: number, limit?: number): Promise<OperationEvent[]> {
    const list = this.eventsByOpId.get(opId) ?? [];
    const normalizedSince = normalizeSinceEventId(sinceEventId);
    const filtered = list.filter((event) => event.eventId > normalizedSince);
    if (!Number.isFinite(limit ?? 0) || !limit || limit <= 0) return filtered;
    return filtered.slice(0, Math.floor(limit));
  }

  async subscribe(input: {
    opId: string;
    sinceEventId?: number;
    onEvent: (event: OperationEvent) => void | Promise<void>;
    onError?: (error: unknown) => void;
  }): Promise<() => void> {
    const replay = await this.listSince(input.opId, normalizeSinceEventId(input.sinceEventId));
    for (const event of replay) {
      try {
        await input.onEvent(event);
      } catch (error) {
        input.onError?.(error);
      }
    }

    const listener = (event: OperationEvent): void => {
      Promise.resolve(input.onEvent(event)).catch((error) => {
        input.onError?.(error);
      });
    };

    const topic = topicFor(input.opId);
    this.emitter.on(topic, listener);
    return () => {
      this.emitter.off(topic, listener);
    };
  }
}

import type {
  WorkerOperationEvent,
  WorkerOperationKind,
  WorkerOperationRequest,
  WorkerOperationState,
} from '../api-contracts';

export type OperationRequest = WorkerOperationRequest;
export type OperationState<Result = unknown> = WorkerOperationState<Result>;
export type OperationEvent<Result = unknown> = WorkerOperationEvent<Result>;

export interface QueuedOperation<TPayload = unknown> {
  jobId: string;
  opId: string;
  opKey: string;
  kind: WorkerOperationKind;
  queuedAt: number;
  payload: TPayload;
}

export interface OperationQueue<TPayload = unknown> {
  enqueue(job: QueuedOperation<TPayload>): Promise<void>;
  claimNext(kind: WorkerOperationKind): Promise<QueuedOperation<TPayload> | null>;
  size(kind?: WorkerOperationKind): number;
}

export interface OperationIndexEntry {
  opId: string;
}

export interface OperationStateStore<Result = unknown> {
  getOpState(opId: string): Promise<OperationState<Result> | null>;
  putOpState(state: OperationState<Result>): Promise<void>;
  getOpIndex(opKey: string): Promise<OperationIndexEntry | null>;
  compareAndSetOpIndex(input: {
    opKey: string;
    newOpId: string;
    expectedOpId: string | null;
  }): Promise<boolean>;
}

export interface OperationEventStream<Result = unknown> {
  append(opId: string, snapshot: OperationState<Result>): Promise<OperationEvent<Result>>;
  listSince(opId: string, sinceEventId: number, limit?: number): Promise<OperationEvent<Result>[]>;
  subscribe(input: {
    opId: string;
    sinceEventId?: number;
    onEvent: (event: OperationEvent<Result>) => void | Promise<void>;
    onError?: (error: unknown) => void;
  }): Promise<() => void>;
}

export interface OperationClock {
  now(): number;
}

export interface OperationIdFactory {
  opId(): string;
  jobId(): string;
}

export interface OperationLifecycleConfig {
  opStaleMs: number;
  maxCasRetries?: number;
}

export type OperationTransitionStatus = 'queued' | 'running' | 'succeeded' | 'failed';

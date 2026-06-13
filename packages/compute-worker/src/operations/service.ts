import { randomUUID } from 'node:crypto';
import type {
  WorkerJobErrorShape,
  WorkerJobTiming,
  WorkerOperationKind,
  WorkerOperationRequest,
  WorkerOperationState,
} from '../operations/contracts';
import {
  buildQueuedState,
  createErrorShape,
  explainReplacementReason,
  isTerminalStatus,
  shouldReuseExistingOperation,
} from './state-machine';
import type {
  OperationClock,
  OperationEventStream,
  OperationIdFactory,
  OperationLifecycleConfig,
  OperationQueue,
  OperationStateStore,
  QueuedOperation,
} from './types';

const RETRY_DELAY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface OperationOrchestratorDeps {
  queue: OperationQueue;
  stateStore: OperationStateStore;
  eventStream: OperationEventStream;
  config: OperationLifecycleConfig;
  clock?: OperationClock;
  idFactory?: OperationIdFactory;
}

export class OperationOrchestrator {
  private readonly queue: OperationQueue;
  private readonly stateStore: OperationStateStore;
  private readonly eventStream: OperationEventStream;
  private readonly opStaleMs: number;
  private readonly maxCasRetries: number;
  private readonly clock: OperationClock;
  private readonly ids: OperationIdFactory;

  constructor(deps: OperationOrchestratorDeps) {
    this.queue = deps.queue;
    this.stateStore = deps.stateStore;
    this.eventStream = deps.eventStream;
    this.opStaleMs = deps.config.opStaleMs;
    this.maxCasRetries = Math.max(1, Math.floor(deps.config.maxCasRetries ?? 10));
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.ids = deps.idFactory ?? {
      opId: () => randomUUID(),
      jobId: () => randomUUID(),
    };
  }

  private async persistState(state: WorkerOperationState): Promise<void> {
    await this.stateStore.putOpState(state);
    await this.eventStream.append(state.opId, state);
  }

  private buildQueuedJob(state: WorkerOperationState, request: WorkerOperationRequest): QueuedOperation {
    return {
      jobId: state.jobId,
      opId: state.opId,
      opKey: state.opKey,
      kind: state.kind,
      queuedAt: state.queuedAt,
      payload: request.payload,
    };
  }

  async enqueueOrReuse(request: WorkerOperationRequest): Promise<WorkerOperationState> {
    const opKey = request.opKey.trim();

    for (let attempt = 0; attempt < this.maxCasRetries; attempt += 1) {
      const indexEntry = await this.stateStore.getOpIndex(opKey);
      if (indexEntry?.opId) {
        const current = await this.stateStore.getOpState(indexEntry.opId);
        if (!current) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        const now = this.clock.now();
        if (shouldReuseExistingOperation({
          current,
          requestKind: request.kind,
          now,
          opStaleMs: this.opStaleMs,
        })) {
          return current;
        }

        const replacement = buildQueuedState({
          request,
          opId: this.ids.opId(),
          jobId: this.ids.jobId(),
          queuedAt: now,
        });

        const replaced = await this.stateStore.compareAndSetOpIndex({
          opKey,
          newOpId: replacement.opId,
          expectedOpId: indexEntry.opId,
        });
        if (!replaced) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }

        await this.persistState(replacement);

        try {
          await this.queue.enqueue(this.buildQueuedJob(replacement, request));
          return replacement;
        } catch (error) {
          const failed: WorkerOperationState = {
            ...replacement,
            status: 'failed',
            updatedAt: this.clock.now(),
            error: createErrorShape(error),
          };
          await this.persistState(failed);
          return failed;
        }
      }

      const now = this.clock.now();
      const created = buildQueuedState({
        request,
        opId: this.ids.opId(),
        jobId: this.ids.jobId(),
        queuedAt: now,
      });

      const createdIndex = await this.stateStore.compareAndSetOpIndex({
        opKey,
        newOpId: created.opId,
        expectedOpId: null,
      });
      if (!createdIndex) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      await this.persistState(created);

      try {
        await this.queue.enqueue(this.buildQueuedJob(created, request));
        return created;
      } catch (error) {
        const failed: WorkerOperationState = {
          ...created,
          status: 'failed',
          updatedAt: this.clock.now(),
          error: createErrorShape(error),
        };
        await this.persistState(failed);
        return failed;
      }
    }

    throw new Error('Unable to reserve operation after repeated CAS conflicts');
  }

  async getState(opId: string): Promise<WorkerOperationState | null> {
    return this.stateStore.getOpState(opId);
  }

  async markRunning(input: {
    opId: string;
    startedAt?: number;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<WorkerOperationState> {
    const current = await this.requireState(input.opId);
    const now = input.updatedAt ?? this.clock.now();

    const next: WorkerOperationState = {
      ...current,
      status: 'running',
      startedAt: input.startedAt ?? current.startedAt ?? now,
      updatedAt: now,
      ...(input.timing ? { timing: input.timing } : {}),
    };

    await this.persistState(next);
    return next;
  }

  async markProgress(input: {
    opId: string;
    progress: WorkerOperationState['progress'];
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<WorkerOperationState> {
    const current = await this.requireState(input.opId);
    const now = input.updatedAt ?? this.clock.now();

    const next: WorkerOperationState = {
      ...current,
      status: 'running',
      startedAt: current.startedAt ?? now,
      updatedAt: now,
      progress: input.progress,
      ...(input.timing ? { timing: input.timing } : {}),
    };

    await this.persistState(next);
    return next;
  }

  async markSucceeded(input: {
    opId: string;
    result: unknown;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<WorkerOperationState> {
    const current = await this.requireState(input.opId);
    const now = input.updatedAt ?? this.clock.now();

    const next: WorkerOperationState = {
      ...current,
      status: 'succeeded',
      startedAt: current.startedAt ?? now,
      updatedAt: now,
      result: input.result,
      ...(input.timing ? { timing: input.timing } : {}),
    };

    await this.persistState(next);
    return next;
  }

  async markFailed(input: {
    opId: string;
    error: WorkerJobErrorShape | string;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<WorkerOperationState> {
    const current = await this.requireState(input.opId);
    const now = input.updatedAt ?? this.clock.now();

    const shape = typeof input.error === 'string' ? { message: input.error } : input.error;

    const next: WorkerOperationState = {
      ...current,
      status: 'failed',
      startedAt: current.startedAt ?? now,
      updatedAt: now,
      error: shape,
      ...(input.timing ? { timing: input.timing } : {}),
    };

    await this.persistState(next);
    return next;
  }

  async markFailedIfUnchanged(input: {
    current: WorkerOperationState;
    expectedRevision: number;
    error: WorkerJobErrorShape | string;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<WorkerOperationState | null> {
    const now = input.updatedAt ?? this.clock.now();
    const shape = typeof input.error === 'string' ? { message: input.error } : input.error;

    const next: WorkerOperationState = {
      ...input.current,
      status: 'failed',
      startedAt: input.current.startedAt ?? now,
      updatedAt: now,
      error: shape,
      ...(input.timing ? { timing: input.timing } : {}),
    };

    const updated = await this.stateStore.compareAndSetOpState({
      opId: input.current.opId,
      expectedRevision: input.expectedRevision,
      newState: next,
    });
    if (!updated) return null;

    await this.eventStream.append(next.opId, next);
    return next;
  }

  async explainReuseDecision(input: {
    current: WorkerOperationState;
    requestKind: WorkerOperationKind;
  }): Promise<string> {
    return explainReplacementReason({
      current: input.current,
      requestKind: input.requestKind,
      now: this.clock.now(),
      opStaleMs: this.opStaleMs,
    });
  }

  private async requireState(opId: string): Promise<WorkerOperationState> {
    const current = await this.stateStore.getOpState(opId);
    if (!current) {
      throw new Error(`Operation not found: ${opId}`);
    }
    if (isTerminalStatus(current.status)) {
      return current;
    }
    return current;
  }
}

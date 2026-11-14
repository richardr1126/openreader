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
  OperationAttemptOutcome,
  OperationAttemptUpdate,
  OperationEventStream,
  OperationExecution,
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
  terminalSettlement?: { track(opId: string, previousStateRevision?: number): Promise<void> };
  publication?: {
    stage(job: QueuedOperation): Promise<void>;
    flush(opId: string): Promise<void>;
  };
}

export class OperationOrchestrator implements OperationExecution {
  private readonly queue: OperationQueue;
  private readonly stateStore: OperationStateStore;
  private readonly eventStream: OperationEventStream;
  private readonly opStaleMs: number;
  private readonly maxCasRetries: number;
  private readonly clock: OperationClock;
  private readonly ids: OperationIdFactory;
  private readonly terminalSettlement: OperationOrchestratorDeps['terminalSettlement'];
  private readonly publication: OperationOrchestratorDeps['publication'];

  constructor(deps: OperationOrchestratorDeps) {
    this.queue = deps.queue;
    this.stateStore = deps.stateStore;
    this.eventStream = deps.eventStream;
    this.terminalSettlement = deps.terminalSettlement;
    this.publication = deps.publication;
    this.opStaleMs = deps.config.opStaleMs;
    this.maxCasRetries = Math.max(1, Math.floor(deps.config.maxCasRetries ?? 10));
    this.clock = deps.clock ?? { now: () => Date.now() };
    this.ids = deps.idFactory ?? {
      opId: () => randomUUID(),
      jobId: () => randomUUID(),
    };
  }

  private async persistState(state: WorkerOperationState): Promise<void> {
    const pendingTerminal = isTerminalStatus(state.status) && this.terminalSettlement;
    if (pendingTerminal) await pendingTerminal.track(state.opId);
    await this.stateStore.putOpState(state);
    if (!pendingTerminal) await this.eventStream.append(state.opId, state);
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
      const current = indexEntry && await this.stateStore.getOpState(indexEntry.opId);
      // During a rolling upgrade an older worker can still write the index
      // before the operation. Give it its normal creation window.
      if (indexEntry && !current && attempt + 1 < this.maxCasRetries) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      const now = this.clock.now();
      if (current && shouldReuseExistingOperation({ current, requestKind: request.kind, now, opStaleMs: this.opStaleMs })) {
        return current;
      }

      const created = buildQueuedState({ request: { ...request, opKey }, opId: this.ids.opId(), jobId: this.ids.jobId(), queuedAt: now });
      const job = this.buildQueuedJob(created, request);
      if (this.publication) {
        created.durableDelivery = true;
        await this.stateStore.putOpState(created);
        await this.publication.stage(job);
      }
      const claimed = await this.stateStore.compareAndSetOpIndex({
        opKey,
        newOpId: created.opId,
        expectedOpId: indexEntry?.opId ?? null,
      });
      if (!claimed) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      if (this.publication) {
        // A failed or ambiguous publish is replayed by the durable outbox.
        await this.publication.flush(created.opId);
        return created;
      }

      await this.persistState(created);
      try {
        await this.queue.enqueue(job);
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

  async claimAttempt(input: Parameters<OperationExecution['claimAttempt']>[0]): ReturnType<OperationExecution['claimAttempt']> {
    for (let attempt = 0; attempt < this.maxCasRetries; attempt += 1) {
      const record = await this.stateStore.getOpStateRecord(input.opId);
      if (!record || record.state.jobId !== input.jobId) return 'missing';
      const current = record.state;
      if (current.status === 'succeeded' || current.status === 'failed') return current.status;
      if (input.deliveryAttempt <= (current.deliveryAttempt ?? 0)) return 'superseded';
      const expired = current.startedAt === undefined && input.queueDeadline !== undefined
        && input.updatedAt > input.queueDeadline;

      const next: WorkerOperationState = {
        ...current,
        status: 'running',
        deliveryAttempt: input.deliveryAttempt,
        ...(expired || input.willRun === false ? {} : { startedAt: current.startedAt ?? input.updatedAt }),
        updatedAt: Math.max(current.updatedAt + 1, input.updatedAt),
        ...(input.timing ? { timing: input.timing } : {}),
      };
      if (await this.persistStateIfUnchanged(next, record.revision)) return expired ? 'expired' : 'claimed';
    }
    throw new Error('Unable to claim operation attempt after repeated CAS conflicts');
  }

  async updateAttempt(input: Parameters<OperationExecution['updateAttempt']>[0]): Promise<boolean> {
    return this.writeAttempt(input, input.progress ? { progress: input.progress } : {});
  }

  async settleAttempt(input: OperationAttemptUpdate & OperationAttemptOutcome): Promise<boolean> {
    const outcome: OperationAttemptOutcome = input.status === 'succeeded'
      ? { status: 'succeeded', result: input.result }
      : { status: 'failed', error: input.error };
    return this.writeAttempt(input, outcome);
  }

  async failExhaustedDelivery(input: { opId: string; jobId: string; deliveryAttempt: number }): Promise<void> {
    for (let attempt = 0; attempt < this.maxCasRetries; attempt += 1) {
      const record = await this.stateStore.getOpStateRecord(input.opId);
      if (!record || record.state.jobId !== input.jobId || isTerminalStatus(record.state.status)
        || (record.state.deliveryAttempt ?? 0) > input.deliveryAttempt) return;
      const failed = await this.markFailedIfUnchanged({
        current: record.state,
        expectedRevision: record.revision,
        error: {
          code: 'WORKER_ORPHANED_OP',
          message: 'The job did not finish before its delivery attempts ran out.',
        },
      });
      if (failed) return;
    }
    throw new Error('Unable to close exhausted operation after repeated CAS conflicts');
  }

  async failUnpublishedJob(job: QueuedOperation): Promise<void> {
    const record = await this.stateStore.getOpStateRecord(job.opId);
    if (!record || record.state.jobId !== job.jobId || record.state.status !== 'queued') return;
    const failed = await this.markFailedIfUnchanged({
      current: record.state,
      expectedRevision: record.revision,
      error: { code: 'COMPUTE_WORK_NOT_STARTED', message: 'The worker could not publish this job before its queue deadline.' },
    });
    if (!failed) throw new Error('The queued operation changed during publication reconciliation');
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
      updatedAt: Math.max(input.current.updatedAt + 1, now),
      error: shape,
      ...(input.timing ? { timing: input.timing } : {}),
    };

    return await this.persistStateIfUnchanged(next, input.expectedRevision) ? next : null;
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

  private async writeAttempt(
    input: OperationAttemptUpdate,
    patch: Pick<WorkerOperationState, 'progress'> | OperationAttemptOutcome,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < this.maxCasRetries; attempt += 1) {
      const record = await this.stateStore.getOpStateRecord(input.opId);
      if (!record || isTerminalStatus(record.state.status)
        || record.state.deliveryAttempt !== input.deliveryAttempt) return false;
      const next = {
        ...record.state,
        ...patch,
        updatedAt: Math.max(record.state.updatedAt + 1, input.updatedAt),
        ...(input.timing ? { timing: input.timing } : {}),
      };
      if (await this.persistStateIfUnchanged(next, record.revision)) return true;
    }
    throw new Error('Unable to update operation attempt after repeated CAS conflicts');
  }

  private async persistStateIfUnchanged(state: WorkerOperationState, expectedRevision: number): Promise<boolean> {
    // Record the unfinished side effects before committing terminal state so a
    // crash between the compare-and-set and event publication is recoverable.
    const pendingTerminal = isTerminalStatus(state.status) && this.terminalSettlement;
    if (pendingTerminal) await pendingTerminal.track(state.opId, expectedRevision);
    const updated = await this.stateStore.compareAndSetOpState({
      opId: state.opId,
      expectedRevision,
      newState: state,
    });
    if (!updated) return false;
    if (!pendingTerminal) await this.eventStream.append(state.opId, state);
    return true;
  }
}

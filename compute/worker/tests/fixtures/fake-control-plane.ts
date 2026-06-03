import type {
  PdfLayoutJobResult,
  WhisperAlignJobResult,
  WorkerOperationEvent,
  WorkerOperationRequest,
  WorkerOperationState,
} from '@openreader/compute-core/api-contracts';
import type { ComputeWorkerRouteDeps } from '../../src/runtime';

type ComputeResult = WhisperAlignJobResult | PdfLayoutJobResult;
type ComputeState = WorkerOperationState<ComputeResult>;
type ComputeEvent = WorkerOperationEvent<ComputeResult>;

export class FakeControlPlane {
  private readonly stateByOpId = new Map<string, ComputeState>();
  private readonly opIdByOpKey = new Map<string, string>();
  private readonly eventsByOpId = new Map<string, ComputeEvent[]>();
  private nextOpId = 1;

  readonly deps: ComputeWorkerRouteDeps = {
    orchestrator: {
      enqueueOrReuse: async (request) => this.enqueueOrReuse(request),
      markRunning: async (input) => this.updateState(input.opId, {
        status: 'running',
        startedAt: input.startedAt,
        updatedAt: input.updatedAt,
        timing: input.timing,
      }),
      markProgress: async (input) => this.updateState(input.opId, {
        status: 'running',
        progress: input.progress,
        updatedAt: input.updatedAt,
        timing: input.timing,
      }),
      markSucceeded: async (input) => this.updateState(input.opId, {
        status: 'succeeded',
        result: input.result as ComputeResult,
        updatedAt: input.updatedAt,
        timing: input.timing,
      }),
      markFailed: async (input) => this.updateState(input.opId, {
        status: 'failed',
        error: typeof input.error === 'string' ? { message: input.error } : input.error,
        updatedAt: input.updatedAt,
        timing: input.timing,
      }),
    },
    operationStateStore: {
      getOpState: async (opId) => this.stateByOpId.get(opId) ?? null,
      listOpStates: async () => Array.from(this.stateByOpId.values()),
    },
    operationEventStream: {
      subscribe: async ({ opId, sinceEventId, onEvent }) => {
        const since = Math.max(0, Math.floor(sinceEventId ?? 0));
        const replay = (this.eventsByOpId.get(opId) ?? []).filter((event) => event.eventId > since);
        for (const event of replay) {
          await onEvent(event);
        }
        return () => undefined;
      },
    },
  };

  seedState(state: ComputeState): void {
    this.stateByOpId.set(state.opId, state);
    this.opIdByOpKey.set(state.opKey, state.opId);
  }

  seedEvent(opId: string, event: ComputeEvent): void {
    const list = this.eventsByOpId.get(opId) ?? [];
    list.push(event);
    this.eventsByOpId.set(opId, list);
  }

  getState(opId: string): ComputeState | null {
    return this.stateByOpId.get(opId) ?? null;
  }

  private async enqueueOrReuse(request: WorkerOperationRequest): Promise<ComputeState> {
    const existingId = this.opIdByOpKey.get(request.opKey);
    if (existingId) {
      const existing = this.stateByOpId.get(existingId);
      if (existing) return existing;
    }

    const now = Date.now();
    const opId = `op-${this.nextOpId++}`;
    const state: ComputeState = {
      opId,
      opKey: request.opKey,
      kind: request.kind,
      jobId: `job-${opId}`,
      status: 'queued',
      queuedAt: now,
      updatedAt: now,
    };

    this.stateByOpId.set(opId, state);
    this.opIdByOpKey.set(request.opKey, opId);
    this.seedEvent(opId, { eventId: 1, snapshot: state });
    return state;
  }

  private async updateState(
    opId: string,
    patch: Partial<ComputeState>,
  ): Promise<ComputeState> {
    const current = this.stateByOpId.get(opId);
    if (!current) {
      throw new Error(`Unknown opId: ${opId}`);
    }
    const next: ComputeState = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? Date.now(),
    };
    this.stateByOpId.set(opId, next);
    const currentEvents = this.eventsByOpId.get(opId) ?? [];
    const nextEventId = (currentEvents.at(-1)?.eventId ?? 0) + 1;
    currentEvents.push({ eventId: nextEventId, snapshot: next });
    this.eventsByOpId.set(opId, currentEvents);
    return next;
  }
}

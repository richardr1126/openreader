import type {
  PdfLayoutJobResult,
  WhisperAlignJobResult,
  WorkerOperationEvent,
  WorkerOperationRequest,
  WorkerOperationState,
} from '../../src/operations/contracts';
import type { ComputeWorkerRouteDeps } from '../../src/api/app';

type ComputeResult = WhisperAlignJobResult | PdfLayoutJobResult;
type ComputeState = WorkerOperationState<ComputeResult>;
type ComputeEvent = WorkerOperationEvent<ComputeResult>;

export class FakeControlPlane {
  private readonly stateByOpId = new Map<string, ComputeState>();
  private readonly revisionByOpId = new Map<string, number>();
  private readonly opIdByOpKey = new Map<string, string>();
  private readonly eventsByOpId = new Map<string, ComputeEvent[]>();
  private readonly artifactKeys = new Set<string>();
  private nextOpId = 1;

  readonly deps = {
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
      markFailedIfUnchanged: async (input) => this.compareAndSetFailed(input),
    },
    operationStateStore: {
      getOpState: async (opId) => this.stateByOpId.get(opId) ?? null,
      getOpStateRecord: async (opId) => {
        const state = this.stateByOpId.get(opId);
        if (!state) return null;
        return {
          state,
          revision: this.revisionByOpId.get(opId) ?? 0,
        };
      },
      listOpStates: async () => Array.from(this.stateByOpId.values()),
      getOpIndex: async (opKey) => {
        const opId = this.opIdByOpKey.get(opKey);
        return opId ? { opId } : null;
      },
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
    artifactExists: async (key) => this.artifactKeys.has(key),
  } satisfies ComputeWorkerRouteDeps;

  seedState(state: ComputeState): void {
    this.stateByOpId.set(state.opId, state);
    this.revisionByOpId.set(state.opId, (this.revisionByOpId.get(state.opId) ?? 0) + 1);
    this.opIdByOpKey.set(state.opKey, state.opId);
  }

  seedEvent(opId: string, event: ComputeEvent): void {
    const list = this.eventsByOpId.get(opId) ?? [];
    list.push(event);
    this.eventsByOpId.set(opId, list);
  }

  seedArtifact(key: string): void {
    this.artifactKeys.add(key);
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
    this.revisionByOpId.set(opId, 1);
    this.opIdByOpKey.set(request.opKey, opId);
    this.seedEvent(opId, { eventId: 1, snapshot: state });
    return state;
  }

  private async compareAndSetFailed(input: {
    current: ComputeState;
    expectedRevision: number;
    error: { message: string; code?: string } | string;
    updatedAt?: number;
    timing?: ComputeState['timing'];
  }): Promise<ComputeState | null> {
    const currentRevision = this.revisionByOpId.get(input.current.opId) ?? 0;
    if (currentRevision !== input.expectedRevision) return null;
    return this.updateState(input.current.opId, {
      ...input.current,
      status: 'failed',
      error: typeof input.error === 'string' ? { message: input.error } : input.error,
      updatedAt: input.updatedAt,
      timing: input.timing,
    });
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
    this.revisionByOpId.set(opId, (this.revisionByOpId.get(opId) ?? 0) + 1);
    const currentEvents = this.eventsByOpId.get(opId) ?? [];
    const nextEventId = (currentEvents.at(-1)?.eventId ?? 0) + 1;
    currentEvents.push({ eventId: nextEventId, snapshot: next });
    this.eventsByOpId.set(opId, currentEvents);
    return next;
  }
}

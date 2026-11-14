import type { WorkerJobTiming } from './contracts';
import {
  recoverOrphanedOperations,
  recoverStaleOperation,
  type StreamedOperationState,
} from './recovery';

export interface ReconciliationStateStore {
  getOpState(opId: string): Promise<StreamedOperationState | null>;
  getOpStateRecord?(opId: string): Promise<{ state: StreamedOperationState; revision: number } | null>;
  getOpIndex?(opKey: string): Promise<{ opId: string } | null>;
  listOpStates?(): Promise<StreamedOperationState[]>;
}

export interface ReconciliationOrchestrator {
  markFailedIfUnchanged?(input: {
    current: StreamedOperationState;
    expectedRevision: number;
    error: { message: string; code?: string } | string;
    updatedAt?: number;
    timing?: WorkerJobTiming;
  }): Promise<unknown>;
}

interface ReconciliationLogger {
  warn(data: unknown, message?: string): void;
}

function supportsRecovery(
  stateStore: ReconciliationStateStore,
  orchestrator: ReconciliationOrchestrator,
): boolean {
  return typeof stateStore.listOpStates === 'function'
    && typeof stateStore.getOpStateRecord === 'function'
    && typeof orchestrator.markFailedIfUnchanged === 'function';
}

export function createOperationReconciler(input: {
  stateStore: ReconciliationStateStore;
  orchestrator: ReconciliationOrchestrator;
  opStaleMs: number;
  getGeneration: () => number;
  logger: ReconciliationLogger;
}) {
  let recoveryPromise: Promise<void> | null = null;
  let recoveredGeneration = -1;

  const run = async (options?: { force?: boolean }): Promise<void> => {
    if (!supportsRecovery(input.stateStore, input.orchestrator)) return;
    const generation = input.getGeneration();
    if (!options?.force && recoveredGeneration === generation) return;
    if (recoveryPromise) return await recoveryPromise;

    recoveryPromise = (async () => {
      const recoveredStates = await recoverOrphanedOperations({
        operationStateStore: {
          getOpStateRecord: (opId) => input.stateStore.getOpStateRecord!(opId),
          listOpStates: () => input.stateStore.listOpStates!(),
        },
        orchestrator: {
          markFailedIfUnchanged: async (request) => {
            const result = await input.orchestrator.markFailedIfUnchanged!(request);
            return result as StreamedOperationState | null;
          },
        },
        opStaleMs: input.opStaleMs,
      });
      if (recoveredStates.length > 0) {
        input.logger.warn({
          recoveredCount: recoveredStates.length,
          ops: recoveredStates.map((state) => ({
            opId: state.opId,
            kind: state.kind,
            status: state.status,
          })),
        }, 'recovered stale in-flight operations during reconciliation');
      }
      recoveredGeneration = generation;
    })().finally(() => {
      recoveryPromise = null;
    });
    await recoveryPromise;
  };

  return {
    run,
    /**
     * Read one operation, settling whether it is still alive. The sweep runs
     * once per control-plane generation, so a worker that restarts while a job
     * is in flight can sweep before that job's state has gone stale and then
     * never look again. Reading an operation is the moment its liveness
     * matters, so the read settles it: an abandoned operation becomes a
     * failure the caller can report and retry, rather than a running operation
     * nothing is working on.
     */
    async getOpState(opId: string): Promise<StreamedOperationState | null> {
      await run();
      const state = await input.stateStore.getOpState(opId);
      if (!state || !supportsRecovery(input.stateStore, input.orchestrator)) return state;
      return await recoverStaleOperation({
        operationStateStore: { getOpStateRecord: (id) => input.stateStore.getOpStateRecord!(id) },
        orchestrator: {
          markFailedIfUnchanged: async (request) => (
            await input.orchestrator.markFailedIfUnchanged!(request)
          ) as StreamedOperationState | null,
        },
        state,
        opStaleMs: input.opStaleMs,
      });
    },
  };
}

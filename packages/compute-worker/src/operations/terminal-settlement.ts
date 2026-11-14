import type { WorkerOperationState } from './contracts';
import { toErrorMessage } from '../infrastructure/errors';

const SETTLEMENT_BATCH_SIZE = 16;

export interface PendingTerminalSettlement {
  opId: string;
  revision: number;
}

export function createTerminalSettlement<Result>(input: {
  store: {
    trackTerminalSettlement(opId: string): Promise<void>;
    getTerminalSettlement(opId: string): Promise<PendingTerminalSettlement | null>;
    listTerminalSettlements(limit: number): Promise<PendingTerminalSettlement[]>;
    finishTerminalSettlement(pending: PendingTerminalSettlement): Promise<void>;
    deferTerminalSettlement(pending: PendingTerminalSettlement): Promise<void>;
    getOpState(opId: string): Promise<WorkerOperationState<Result> | null>;
  };
  publish: (state: WorkerOperationState<Result>) => Promise<unknown>;
  notify: (result: { operationId: string; state: 'succeeded' | 'failed' }) => Promise<void>;
  logger: { warn(data: unknown, message: string): void };
}) {
  const { store } = input;
  const active = new Map<string, Promise<void>>();
  let draining: Promise<boolean> | undefined;

  function settle(pending: PendingTerminalSettlement): Promise<void> {
    const inProgress = active.get(pending.opId);
    if (inProgress) return inProgress;
    const task = (async () => {
      const state = await store.getOpState(pending.opId);
      if (!state) {
        await store.finishTerminalSettlement(pending);
        return;
      }
      if (state.status !== 'succeeded' && state.status !== 'failed') {
        await store.deferTerminalSettlement(pending);
        return;
      }
      const results = await Promise.allSettled([
        input.publish(state),
        input.notify({ operationId: pending.opId, state: state.status }),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason;
      }
      await store.finishTerminalSettlement(pending);
    })().finally(() => active.delete(pending.opId));
    active.set(pending.opId, task);
    return task;
  }

  return {
    track: (opId: string) => store.trackTerminalSettlement(opId),
    async flush(opId: string): Promise<void> {
      const pending = await store.getTerminalSettlement(opId);
      if (pending) await settle(pending);
    },
    async drain(): Promise<boolean> {
      if (draining) return draining;
      draining = (async () => {
        const batch = await store.listTerminalSettlements(SETTLEMENT_BATCH_SIZE);
        for (let index = 0; index < batch.length; index += 4) {
          await Promise.all(batch.slice(index, index + 4).map(async (pending) => {
            try {
              await settle(pending);
            } catch (error) {
              input.logger.warn({ opId: pending.opId, error: toErrorMessage(error) }, 'compute terminal settlement failed');
              await store.deferTerminalSettlement(pending);
            }
          }));
        }
        return batch.length > 0;
      })().finally(() => { draining = undefined; });
      return draining;
    },
  };
}

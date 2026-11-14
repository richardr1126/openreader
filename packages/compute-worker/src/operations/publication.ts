import type { OperationQueue, OperationStateStore, QueuedOperation } from './types';
import { toErrorMessage } from '../infrastructure/errors';

export interface PendingOperationPublication {
  job: QueuedOperation;
  revision: number;
}

export function createOperationPublication(input: {
  store: Pick<OperationStateStore, 'getOpIndex' | 'getOpState'> & {
    stagePublication(job: QueuedOperation): Promise<void>;
    getPublication(opId: string): Promise<PendingOperationPublication | null>;
    listPublications(limit: number): Promise<PendingOperationPublication[]>;
    finishPublication(opId: string, revision: number): Promise<void>;
    deferPublication(pending: PendingOperationPublication): Promise<void>;
  };
  queue: Pick<OperationQueue, 'enqueue'>;
  beforePublish?: (job: QueuedOperation) => Promise<void>;
  expire: (job: QueuedOperation) => Promise<void>;
  maxAgeMs: number;
  logger: { warn(data: unknown, message: string): void };
}) {
  const { store } = input;
  async function publish(pending: PendingOperationPublication): Promise<void> {
    const { job, revision } = pending;
    try {
      const state = await store.getOpState(job.opId);
      if (state?.status === 'queued' && state.jobId === job.jobId) {
        const index = await store.getOpIndex(job.opKey);
        if (index?.opId !== job.opId) {
          // The stage is written immediately before claiming the index. A
          // competing worker may still be in that transaction window.
          if (Date.now() - job.queuedAt < 60_000) {
            await store.deferPublication(pending);
            return;
          }
        } else {
          await input.beforePublish?.(job);
          if (Date.now() - job.queuedAt >= input.maxAgeMs) await input.expire(job);
          else await input.queue.enqueue(job);
        }
      }
      await store.finishPublication(job.opId, revision);
    } catch (error) {
      input.logger.warn({ opId: job.opId, error: toErrorMessage(error) }, 'compute operation publication failed');
      await store.deferPublication(pending).catch((deferError: unknown) => {
        input.logger.warn({ opId: job.opId, error: toErrorMessage(deferError) }, 'compute operation publication deferral failed');
      });
    }
  }

  return {
    stage: (job: QueuedOperation) => store.stagePublication(job),
    async flush(opId: string): Promise<void> {
      try {
        const pending = await store.getPublication(opId);
        if (pending) await publish(pending);
      } catch (error) {
        input.logger.warn({ opId, error: toErrorMessage(error) }, 'could not read pending compute publication');
      }
    },
    async drain(): Promise<boolean> {
      const batch = await store.listPublications(16);
      for (let index = 0; index < batch.length; index += 4) {
        await Promise.all(batch.slice(index, index + 4).map((pending) => publish(pending)));
      }
      return batch.length > 0;
    },
  };
}

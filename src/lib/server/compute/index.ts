import type { ComputeBackend } from '@/lib/server/compute/types';
import { isWorkerClientConfigAvailable, WorkerComputeBackend } from '@/lib/server/compute/worker';

let backendPromise: Promise<ComputeBackend> | null = null;

export async function getCompute(): Promise<ComputeBackend> {
  if (!backendPromise) {
    backendPromise = Promise.resolve(new WorkerComputeBackend()).catch((error) => {
      backendPromise = null;
      throw error;
    });
  }
  return backendPromise;
}

export function isComputeAvailable(): boolean {
  return isWorkerClientConfigAvailable();
}

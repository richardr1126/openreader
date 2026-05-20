import type { ComputeBackend, ComputeMode } from '@/lib/server/compute/types';
import { isComputeModeAvailable, readComputeMode } from '@/lib/server/compute/mode';
import { WorkerComputeBackend } from '@/lib/server/compute/worker';

declare const __OPENREADER_COMPUTE_MODE__: 'local' | 'worker' | 'none';

let backendPromise: Promise<ComputeBackend> | null = null;

async function createBackend(): Promise<ComputeBackend> {
  const bundledMode =
    typeof __OPENREADER_COMPUTE_MODE__ === 'undefined' ? 'none' : __OPENREADER_COMPUTE_MODE__;

  if (bundledMode === 'worker') return new WorkerComputeBackend();
  if (bundledMode === 'local') {
    const { LocalComputeBackend } = await import('@/lib/server/compute/local');
    return new LocalComputeBackend();
  }
  const mode: ComputeMode = readComputeMode();
  if (mode === 'worker') return new WorkerComputeBackend();
  const { LocalComputeBackend } = await import('@/lib/server/compute/local');
  return new LocalComputeBackend();
}

export async function getCompute(): Promise<ComputeBackend> {
  if (!backendPromise) {
    backendPromise = createBackend().catch((error) => {
      backendPromise = null;
      throw error;
    });
  }
  return backendPromise;
}

export function isComputeAvailable(): boolean {
  return isComputeModeAvailable();
}

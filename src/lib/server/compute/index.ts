import type { ComputeBackend, ComputeMode } from '@/lib/server/compute/types';
import { isComputeModeAvailable, readComputeMode } from '@/lib/server/compute/mode';
import { WorkerComputeBackend } from '@/lib/server/compute/worker';

let backend: ComputeBackend | null = null;

function createBackend(): ComputeBackend {
  const mode: ComputeMode = readComputeMode();
  if (mode === 'worker') return new WorkerComputeBackend();
  // Intentionally lazy-load local compute to avoid tracing heavy ONNX
  // dependencies unless the backend is actually local.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { LocalComputeBackend } = require('@/lib/server/compute/local') as typeof import('@/lib/server/compute/local');
  return new LocalComputeBackend();
}

export function getCompute(): ComputeBackend {
  if (!backend) backend = createBackend();
  return backend;
}

export function isComputeAvailable(): boolean {
  return isComputeModeAvailable();
}

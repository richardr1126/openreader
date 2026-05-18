import type { ComputeBackend, ComputeMode } from '@/lib/server/compute/types';
import { LocalComputeBackend } from '@/lib/server/compute/local';
import { NoneComputeBackend } from '@/lib/server/compute/none';

let backend: ComputeBackend | null = null;

function readMode(): ComputeMode {
  const raw = (process.env.OPENREADER_COMPUTE_MODE || 'local').trim().toLowerCase();
  if (raw === 'local' || raw === 'none' || raw === 'worker') return raw;
  return 'local';
}

function createBackend(): ComputeBackend {
  const mode = readMode();
  if (mode === 'none') return new NoneComputeBackend();
  if (mode === 'worker') {
    throw new Error(
      'OPENREADER_COMPUTE_MODE=worker is not implemented yet in v1. Switch to local/none or implement WorkerComputeBackend (v2).',
    );
  }
  return new LocalComputeBackend();
}

export function getCompute(): ComputeBackend {
  if (!backend) backend = createBackend();
  return backend;
}

export function isComputeAvailable(): boolean {
  const mode = readMode();
  if (mode === 'worker') {
    throw new Error(
      'OPENREADER_COMPUTE_MODE=worker is not implemented yet in v1. Switch to local/none or implement WorkerComputeBackend (v2).',
    );
  }
  return mode !== 'none';
}

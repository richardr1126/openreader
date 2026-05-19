import type { ComputeMode } from '@/lib/server/compute/types';

export function readComputeMode(): ComputeMode {
  const raw = (process.env.OPENREADER_COMPUTE_MODE || 'local').trim().toLowerCase();
  if (raw === 'local' || raw === 'none' || raw === 'worker') return raw;
  return 'local';
}

export function isComputeModeAvailable(mode: ComputeMode): boolean {
  if (mode === 'worker') {
    throw new Error(
      'OPENREADER_COMPUTE_MODE=worker is not implemented yet in v1. Switch to local/none or implement WorkerComputeBackend (v2).',
    );
  }
  return mode !== 'none';
}

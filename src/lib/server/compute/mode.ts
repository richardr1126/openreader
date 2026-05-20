import type { ComputeMode } from '@/lib/server/compute/types';

export function readComputeMode(): ComputeMode {
  const envValue = process.env.COMPUTE_MODE;
  const raw = (envValue || '').trim().toLowerCase();
  if (!raw) return 'local';
  if (raw === 'local' || raw === 'worker') return raw;
  throw new Error(
    `Invalid COMPUTE_MODE="${envValue}". Expected "local" or "worker".`,
  );
}

export function isComputeModeAvailable(): boolean {
  // Throws on invalid values so startup/runtime config fails fast.
  readComputeMode();
  return true;
}

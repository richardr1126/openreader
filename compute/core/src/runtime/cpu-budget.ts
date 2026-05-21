import os from 'node:os';

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function getComputeJobConcurrency(): number {
  return readPositiveInt('COMPUTE_JOB_CONCURRENCY', 1);
}

export function getAvailableCpuCores(): number {
  if (typeof os.availableParallelism === 'function') {
    const value = os.availableParallelism();
    if (Number.isFinite(value) && value >= 1) return Math.floor(value);
  }
  const fallback = os.cpus().length;
  return Number.isFinite(fallback) && fallback >= 1 ? Math.floor(fallback) : 1;
}

export function getOnnxThreadsPerJob(): number {
  const concurrency = getComputeJobConcurrency();
  const usableCores = Math.max(1, getAvailableCpuCores() - 1);
  return Math.max(1, Math.floor(usableCores / concurrency));
}

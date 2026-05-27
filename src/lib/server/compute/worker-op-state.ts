import { getWorkerClientConfigFromEnv } from '@/lib/server/compute/worker';
import type { WorkerOperationState } from '@openreader/compute-core/api-contracts';

const WORKER_OP_REQUEST_TIMEOUT_MS = 2_500;

export async function fetchWorkerOperationState<Result>(
  opId: string | null | undefined,
): Promise<WorkerOperationState<Result> | null> {
  const normalized = opId?.trim();
  if (!normalized) return null;

  let cfg: { baseUrl: string; token: string };
  try {
    cfg = getWorkerClientConfigFromEnv();
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WORKER_OP_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${cfg.baseUrl}/ops/${encodeURIComponent(normalized)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const parsed = await res.json() as WorkerOperationState<Result>;
    if (!parsed || typeof parsed !== 'object' || parsed.opId !== normalized) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}


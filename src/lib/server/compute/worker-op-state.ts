import { getWorkerClientConfigFromEnv } from '@/lib/server/compute/worker';
import type { WorkerOperationState } from '@openreader/compute-core/api-contracts';
import { serverLogger } from '@/lib/server/logger';

const WORKER_OP_REQUEST_TIMEOUT_MS = 2_500;

export async function fetchWorkerOperationState<Result>(
  opId: string | null | undefined,
): Promise<WorkerOperationState<Result> | null> {
  const normalized = opId?.trim();
  if (!normalized) return null;

  let cfg: { baseUrl: string; token: string };
  try {
    cfg = getWorkerClientConfigFromEnv();
  } catch (error) {
    serverLogger.warn({
      opId: normalized,
      error: error instanceof Error ? error.message : String(error),
    }, '[worker-op-state] worker client env missing/invalid');
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

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      serverLogger.warn({
        opId: normalized,
        status: res.status,
        detail,
      }, '[worker-op-state] worker op request failed');
      return null;
    }
    const parsed = await res.json() as WorkerOperationState<Result>;
    if (!parsed || typeof parsed !== 'object' || parsed.opId !== normalized) {
      serverLogger.warn({
        opId: normalized,
      }, '[worker-op-state] worker op response invalid');
      return null;
    }
    return parsed;
  } catch (error) {
    serverLogger.warn({
      opId: normalized,
      error: error instanceof Error ? error.message : String(error),
    }, '[worker-op-state] worker op request threw');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

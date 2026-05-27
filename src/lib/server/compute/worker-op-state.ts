import { getWorkerClientConfigFromEnv } from '@/lib/server/compute/worker';
import type { WorkerOperationState } from '@openreader/compute-core/api-contracts';
import { errorToLog, serverLogger } from '@/lib/server/logger';

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
      event: 'compute.worker_op_state.config.invalid',
      errorCode: 'COMPUTE_WORKER_OP_STATE_CONFIG_INVALID',
      opId: normalized,
      degraded: true,
      step: 'read_worker_config',
      error: errorToLog(error),
    }, 'Worker client env missing/invalid');
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
      const upstreamResponseBody = await res.text().catch(() => '');
      serverLogger.warn({
        event: 'compute.worker_op_state.fetch.failed',
        errorCode: 'COMPUTE_WORKER_OP_STATE_FETCH_FAILED',
        opId: normalized,
        status: res.status,
        upstreamResponseBody,
        degraded: true,
        step: 'fetch_worker_op',
        error: {
          name: 'WorkerOpStateFetchFailed',
          message: `Worker op request failed with status ${res.status}`,
        },
      }, 'Worker op request failed');
      return null;
    }
    const parsed = await res.json() as WorkerOperationState<Result>;
    if (!parsed || typeof parsed !== 'object' || parsed.opId !== normalized) {
      serverLogger.warn({
        event: 'compute.worker_op_state.response.invalid',
        errorCode: 'COMPUTE_WORKER_OP_STATE_RESPONSE_INVALID',
        opId: normalized,
        degraded: true,
        step: 'validate_worker_op_response',
      }, 'Worker op response invalid');
      return null;
    }
    return parsed;
  } catch (error) {
    serverLogger.warn({
      event: 'compute.worker_op_state.fetch.error',
      errorCode: 'COMPUTE_WORKER_OP_STATE_FETCH_ERROR',
      opId: normalized,
      degraded: true,
      step: 'fetch_worker_op',
      error: errorToLog(error),
    }, 'Worker op request threw');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

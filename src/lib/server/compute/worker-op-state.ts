import { getWorkerClientConfigFromEnv } from '@/lib/server/compute/worker';
import type { WorkerOperationState } from '@openreader/compute-core/api-contracts';
import { serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';

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
    logDegraded(serverLogger, {
      event: 'compute.worker_op_state.config.invalid',
      msg: 'Worker client env missing/invalid',
      step: 'read_worker_config',
      context: { opId: normalized },
      error,
    });
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
      logDegraded(serverLogger, {
        event: 'compute.worker_op_state.fetch.failed',
        msg: 'Worker op request failed',
        step: 'fetch_worker_op',
        context: {
          opId: normalized,
          status: res.status,
          upstreamResponseBody,
        },
        error: {
          name: 'WorkerOpStateFetchFailed',
          message: `Worker op request failed with status ${res.status}`,
        },
      });
      return null;
    }
    const parsed = await res.json() as WorkerOperationState<Result>;
    if (!parsed || typeof parsed !== 'object' || parsed.opId !== normalized) {
      logDegraded(serverLogger, {
        event: 'compute.worker_op_state.response.invalid',
        msg: 'Worker op response invalid',
        step: 'validate_worker_op_response',
        context: { opId: normalized },
      });
      return null;
    }
    return parsed;
  } catch (error) {
    logDegraded(serverLogger, {
      event: 'compute.worker_op_state.fetch.error',
      msg: 'Worker op request threw',
      step: 'fetch_worker_op',
      context: { opId: normalized },
      error,
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

import type { ComputeOperation } from '@/lib/server/compute-worker/protocol';
import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import { logDegraded } from '@/lib/server/errors/logging';
import { serverLogger } from '@/lib/server/logger';
import type {
  ComputeLimitPolicyDocument,
  WorkerOperationAction,
} from '@openreader/runtime-config/compute-limits';
import type { ComputeLimitSubject } from './policy';
import {
  activateComputeAdmission,
  finishComputeAdmission,
  reserveComputeAdmission,
} from './admission';

export class ComputeAdmissionLimitedError extends Error {
  readonly code = 'COMPUTE_ADMISSION_RATE_LIMITED';
  readonly httpStatus = 429;
  readonly retryable = true;
  readonly details: { retryAfterMs: number };

  constructor(readonly retryAfterMs: number) {
    super('Compute work is temporarily limited. Please try again shortly.');
    this.name = 'ComputeAdmissionLimitedError';
    this.details = { retryAfterMs };
  }
}

async function linkOperationWithRetry(input: {
  admissionId: string;
  operationId: string;
  leaseSeconds: number;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await activateComputeAdmission(input);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function createAdmittedComputeOperation<T extends ComputeOperation>(input: {
  policy: ComputeLimitPolicyDocument;
  action: WorkerOperationAction;
  requestKey: string;
  subject: ComputeLimitSubject;
  create: () => Promise<T>;
}): Promise<T> {
  const decision = await reserveComputeAdmission(input);
  if (!decision.allowed || !decision.admissionId) {
    throw new ComputeAdmissionLimitedError(decision.retryAfterMs);
  }
  const leaseSeconds = Math.max(
    60,
    ...input.policy.actions[input.action].admission.active.map((limit) => limit.leaseSeconds),
  );
  let operation: T | null = null;
  try {
    await activateComputeAdmission({ admissionId: decision.admissionId, leaseSeconds });
    const created = await input.create();
    operation = created;
    await linkOperationWithRetry({
      admissionId: decision.admissionId,
      operationId: created.opId,
      leaseSeconds,
    });
    // The completion callback can arrive before SQL has the operation ID.
    // Read the durable status once after linking so either order settles it.
    const status = created.status === 'queued' || created.status === 'running'
      ? await Promise.resolve().then(() => getComputeWorkerClient().getOperation(created.opId, { signal: AbortSignal.timeout(2_000) }))
        .then((current) => current?.status ?? created.status)
        .catch((error: unknown) => {
          logDegraded(serverLogger, {
            event: 'compute.admission.status_check_failed',
            msg: 'Could not confirm operation status after linking admission',
            step: 'read_linked_operation',
            context: { operationId: created.opId },
            error,
          });
          return created.status;
        })
      : created.status;
    if (status === 'failed') {
      await finishComputeAdmission({ admissionId: decision.admissionId, state: 'cancelled' });
    } else if (status === 'succeeded') {
      await finishComputeAdmission({ admissionId: decision.admissionId, state: 'finished' });
    }
    return operation;
  } catch (error) {
    if (!operation) {
      await finishComputeAdmission({ admissionId: decision.admissionId, state: 'cancelled' })
        .catch(() => undefined);
    }
    throw error;
  }
}

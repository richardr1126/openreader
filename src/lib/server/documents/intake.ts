import { randomUUID } from 'node:crypto';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { consumeComputeUsage } from '@/lib/server/compute-limits/usage';
import type { ComputeLimitSubject } from '@/lib/server/compute-limits/policy';
import { ApiRequestError } from '@/lib/server/api/responses';
import { assertStorageAvailable } from '@/lib/server/storage/usage';

/** Charge once before any source fetch or transfer preparation. */
export async function consumeDocumentIntake(subject: ComputeLimitSubject, id: string = randomUUID()) {
  const config = await getResolvedRuntimeConfig();
  await assertStorageAvailable(subject, 0, config);
  const policy = config.computeLimitPolicies;
  const result = await consumeComputeUsage({ policy, action: 'document_intake', metric: 'files', units: 1, eventKey: `document-intake:${subject.userId}:${id}`, subject });
  if (!result.allowed) throw new ApiRequestError(429, 'DOCUMENT_INTAKE_LIMIT_REACHED', 'Daily document limit reached. Try again after midnight UTC.', result.retryAfterMs);
}

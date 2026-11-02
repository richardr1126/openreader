import { and, eq, inArray, lt, ne, or } from 'drizzle-orm';
import { db } from '@openreader/database';
import {
  computeLimitAdmissions,
  computeLimitBuckets,
  computeLimitEvents,
} from '@openreader/database/schema';
import { COMPUTE_ACTIONS, type WorkerOperationAction } from '@openreader/runtime-config/compute-limits';
import { reconcileExpiredComputeAdmissions } from '@/lib/server/compute-limits/admission';
import type { TaskResult } from '../types';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function rowsAffected(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const value = result as Record<string, unknown>;
  return Number(value.rowCount ?? value.changes ?? 0);
}

export async function pruneComputeLimits(): Promise<TaskResult> {
  const nowMs = Date.now();
  const actions = COMPUTE_ACTIONS.filter((action): action is WorkerOperationAction => action !== 'tts_synthesis' && action !== 'document_intake');
  for (const action of actions) await reconcileExpiredComputeAdmissions(action, nowMs);

  const cutoff = nowMs - RETENTION_MS;
  const [events, buckets, admissions] = await Promise.all([
    db.delete(computeLimitEvents).where(lt(computeLimitEvents.createdAt, cutoff)),
    db.delete(computeLimitBuckets).where(or(
      and(
        ne(computeLimitBuckets.metric, 'active'),
        lt(computeLimitBuckets.windowEnd, cutoff),
      ),
      and(
        eq(computeLimitBuckets.metric, 'active'),
        eq(computeLimitBuckets.used, 0),
        lt(computeLimitBuckets.updatedAt, cutoff),
      ),
    )),
    db.delete(computeLimitAdmissions).where(and(
      inArray(computeLimitAdmissions.state, ['finished', 'cancelled']),
      lt(computeLimitAdmissions.finishedAt, cutoff),
    )),
  ]);
  const pruned = rowsAffected(events) + rowsAffected(buckets) + rowsAffected(admissions);
  return { summary: `Pruned ${pruned} compute-limit record(s)`, pruned };
}

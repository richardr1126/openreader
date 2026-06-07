import { lt } from 'drizzle-orm';
import { db } from '@/db';
import { userJobEvents } from '@/db/schema';
import type { TaskResult } from '../types';

// Retention far exceeds the largest rate-limit window, so pruning never removes
// an event that could still affect an in-window count.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function rowsAffected(result: unknown): number {
  if (result && typeof result === 'object') {
    const rec = result as Record<string, unknown>;
    if (typeof rec.rowCount === 'number') return rec.rowCount;
    if (typeof rec.changes === 'number') return rec.changes;
  }
  return 0;
}

/** Delete rate-limit job-event rows older than the retention window. */
export async function pruneJobEvents(): Promise<TaskResult> {
  const cutoff = Date.now() - RETENTION_MS;
  const result = await db.delete(userJobEvents).where(lt(userJobEvents.createdAt, cutoff));
  const pruned = rowsAffected(result);
  return { summary: `Pruned ${pruned} job event(s)`, pruned };
}

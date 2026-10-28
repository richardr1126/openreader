import { isS3Configured } from '@/lib/server/storage/s3';
import { isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { drainStorageCleanups } from '@/lib/server/storage/cleanups';
import type { TaskContext, TaskResult } from '../types';

/** Run queued document/account storage cleanups that are due or failed earlier. */
export async function retryStorageCleanups(context: TaskContext): Promise<TaskResult> {
  if (!isS3Configured()) {
    return { summary: 'Skipped: object storage not configured', cleared: 0 };
  }
  if (!isComputeWorkerAvailable()) {
    return { summary: 'Skipped: compute worker not configured', cleared: 0 };
  }
  // Leave headroom under the engine's hard limit for the last worker call.
  const result = await drainStorageCleanups({ deadlineAt: context.deadlineAt - 10_000, signal: context.signal });
  const parts = [`Cleared ${result.cleared} storage scope(s)`];
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  if (result.remaining) parts.push('more remain');
  return { summary: parts.join(', '), ...result };
}

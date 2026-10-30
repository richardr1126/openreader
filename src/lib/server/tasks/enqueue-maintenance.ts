import { randomUUID } from 'node:crypto';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { isS3Configured } from '@/lib/server/storage/s3';
import { getRuntimeConfig } from '@/lib/server/admin/settings';
import type { MaintenanceRequest } from '@/lib/server/compute-worker/protocol';
import type { TaskContext, TaskResult } from './types';

export async function enqueueMaintenanceTask(task: MaintenanceRequest['task'], context: TaskContext): Promise<TaskResult> {
  if (!isS3Configured()) return { summary: 'Skipped: object storage not configured' };
  if (!isComputeWorkerAvailable()) throw new Error('Compute worker is required for maintenance');
  const idleBefore = task === 'expire-anonymous-users'
    ? Date.now() - (await getRuntimeConfig()).anonymousUserIdleDays * 86_400_000
    : undefined;
  const operation = await getComputeWorkerClient().createMaintenanceOperation({
    task, runId: context.runId, ...(idleBefore === undefined ? {} : { idleBefore }),
  });
  return { operationId: operation.opId, summary: 'Queued for cleanup' };
}

/** Queue storage cleanup and row deletion for accounts already marked for deletion. */
export async function queueUserDeletion(userIds: string[]) {
  return getComputeWorkerClient().createMaintenanceOperation({ task: 'delete-users', runId: randomUUID(), userIds });
}

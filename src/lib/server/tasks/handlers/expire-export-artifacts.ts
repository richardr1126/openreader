import { isS3Configured } from '@/lib/server/storage/s3';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import type { TaskContext, TaskResult } from '../types';

// Account ZIPs are temporary snapshots. Completed audiobooks stay with their
// source audio until explicit document/audio/account cleanup.
const EXPORT_ARTIFACT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Expire completed export artifacts past the retention window. The broad
 * object scan and deletion run on the compute worker; this handler is only
 * the short scheduled trigger.
 */
export async function expireExportArtifacts(context: TaskContext): Promise<TaskResult> {
  if (!isS3Configured()) {
    return { summary: 'Skipped: object storage not configured', expiredArtifacts: 0 };
  }
  if (!isComputeWorkerAvailable()) {
    return { summary: 'Skipped: compute worker not configured', expiredArtifacts: 0 };
  }
  const client = getComputeWorkerClient();
  const accountExports = await client.expireAccountExportArtifacts(
    { maxAgeMs: EXPORT_ARTIFACT_MAX_AGE_MS }, { signal: context.signal },
  );
  const expiredArtifacts = accountExports.expiredArtifacts;
  return {
    summary: `Expired ${expiredArtifacts} export artifact(s)`,
    expiredArtifacts,
    deletedObjects: accountExports.deletedObjects,
  };
}

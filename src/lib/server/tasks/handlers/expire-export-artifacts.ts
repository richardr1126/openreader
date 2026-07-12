import { isS3Configured } from '@/lib/server/storage/s3';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import type { TaskContext, TaskResult } from '../types';

// Completed export artifacts (account export ZIPs/manifests and audiobook
// export files) are reusable snapshots, not permanent user data: a stale
// artifact is regenerated on the next export request. Seven days comfortably
// covers download retries and refreshes without letting storage grow with
// every "Generate new export".
const EXPORT_ARTIFACT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Expire completed export artifacts past the retention window. The broad
 * object scan and deletion run on the compute worker; this handler is only
 * the short scheduled trigger.
 */
export async function expireExportArtifacts(_context: TaskContext): Promise<TaskResult> {
  if (!isS3Configured()) {
    return { summary: 'Skipped: object storage not configured', expiredArtifacts: 0 };
  }
  if (!isComputeWorkerAvailable()) {
    return { summary: 'Skipped: compute worker not configured', expiredArtifacts: 0 };
  }
  const client = getComputeWorkerClient();
  const [accountExports, audiobookExports] = await Promise.all([
    client.expireAccountExportArtifacts({ maxAgeMs: EXPORT_ARTIFACT_MAX_AGE_MS }),
    client.expireTtsPlaybackExportArtifacts({ maxAgeMs: EXPORT_ARTIFACT_MAX_AGE_MS }),
  ]);
  const expiredArtifacts = accountExports.expiredArtifacts + audiobookExports.expiredArtifacts;
  return {
    summary: `Expired ${expiredArtifacts} export artifact(s)`,
    expiredArtifacts,
    deletedObjects: accountExports.deletedObjects + audiobookExports.deletedObjects,
  };
}

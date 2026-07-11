import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';

/**
 * Delegate document-level playback artifact cleanup to the compute worker.
 * The worker owns the S3 listing/deletion path; Next never scans playback
 * prefixes as part of a request.
 */
export async function deleteDocumentTtsSegmentCache(input: {
  userId: string;
  documentId: string;
  namespace: string | null;
}): Promise<void> {
  if (!isComputeWorkerAvailable()) {
    throw new Error('Compute worker is required to clear playback cache');
  }
  await getComputeWorkerClient().clearTtsPlaybackScope({
    storageUserId: input.userId,
    documentId: input.documentId,
    namespace: input.namespace,
  });
}

import { isS3Configured } from '@/lib/server/storage/s3';
import {
  TEMP_DOCUMENT_UPLOAD_TTL_MS,
  deleteAllExpiredTempDocumentUploads,
} from '@/lib/server/documents/blobstore';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import type { TaskContext, TaskResult } from '../types';

/**
 * Remove temporary upload objects past their TTL across all users, along with
 * the DOCX conversions made from them (a conversion is only read while its
 * temp upload is finalized).
 */
export async function cleanupTempUploads(context: TaskContext): Promise<TaskResult> {
  if (!isS3Configured()) {
    return { summary: 'Skipped: object storage not configured', deleted: 0 };
  }

  const cutoff = Date.now() - TEMP_DOCUMENT_UPLOAD_TTL_MS;
  const deleted = await deleteAllExpiredTempDocumentUploads(null, cutoff, { signal: context.signal });
  const conversions = isComputeWorkerAvailable()
    ? await getComputeWorkerClient().expireDocumentConversionArtifacts(
      { maxAgeMs: TEMP_DOCUMENT_UPLOAD_TTL_MS }, { signal: context.signal },
    )
    : null;
  return {
    summary: `Deleted ${deleted} expired upload object(s)`
      + (conversions ? `, ${conversions.expiredArtifacts} DOCX conversion(s)` : ''),
    deleted,
    expiredConversions: conversions?.expiredArtifacts ?? 0,
  };
}

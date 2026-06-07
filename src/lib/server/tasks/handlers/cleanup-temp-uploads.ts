import { isS3Configured } from '@/lib/server/storage/s3';
import {
  TEMP_DOCUMENT_UPLOAD_TTL_MS,
  deleteAllExpiredTempDocumentUploads,
} from '@/lib/server/documents/blobstore';
import type { TaskContext, TaskResult } from '../types';

/** Remove temporary upload objects past their TTL across all users. */
export async function cleanupTempUploads(context: TaskContext): Promise<TaskResult> {
  if (!isS3Configured()) {
    return { summary: 'Skipped: object storage not configured', deleted: 0 };
  }

  const cutoff = Date.now() - TEMP_DOCUMENT_UPLOAD_TTL_MS;
  const deleted = await deleteAllExpiredTempDocumentUploads(null, cutoff, { signal: context.signal });
  return { summary: `Deleted ${deleted} expired upload object(s)`, deleted };
}

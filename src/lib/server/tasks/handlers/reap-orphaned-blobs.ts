import { inArray } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { isS3Configured } from '@/lib/server/storage/s3';
import { deleteDocumentBlob, listDocumentSourceBlobs } from '@/lib/server/documents/blobstore';
import { deleteDocumentPreviewArtifacts } from '@/lib/server/documents/previews-blobstore';
import { deleteDocumentPreviewRows } from '@/lib/server/documents/previews';
import { serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';
import { tryAcquireDocumentBlobLease } from '@/lib/server/documents/blob-lease';
import type { TaskContext, TaskResult } from '../types';

// Don't reap a blob younger than this — it may belong to an in-flight finalize
// that has written the blob but not yet committed its ownership row.
const GRACE_MS = 60 * 60 * 1000;
const OWNERSHIP_CHECK_BATCH = 200;

/**
 * Delete content-addressed document blobs that no longer have any owner.
 *
 * Reference count = ownership rows in `documents`. A blob with zero rows and
 * age past the grace window is an orphan (e.g. left by a failed inline delete)
 * and is safe to remove. Production data is non-namespaced.
 */
export async function reapOrphanedBlobs(context: TaskContext): Promise<TaskResult> {
  if (!isS3Configured()) {
    return { summary: 'Skipped: object storage not configured', reaped: 0 };
  }

  const now = Date.now();
  const blobs = await listDocumentSourceBlobs(null, { signal: context.signal });
  const candidates = blobs.filter((blob) => now - blob.lastModifiedMs > GRACE_MS);

  let reaped = 0;
  const failures: unknown[] = [];
  for (let i = 0; i < candidates.length; i += OWNERSHIP_CHECK_BATCH) {
    context.signal.throwIfAborted();
    const chunk = candidates.slice(i, i + OWNERSHIP_CHECK_BATCH);
    const ids = chunk.map((c) => c.id);
    const ownedRows = await db
      .select({ id: documents.id })
      .from(documents)
      .where(inArray(documents.id, ids));
    const owned = new Set(ownedRows.map((row: { id: string }) => row.id));

    for (const candidate of chunk) {
      context.signal.throwIfAborted();
      if (owned.has(candidate.id)) continue;
      const lease = await tryAcquireDocumentBlobLease(candidate.id);
      if (!lease) continue;
      try {
        const [owner] = await db
          .select({ id: documents.id })
          .from(documents)
          .where(inArray(documents.id, [candidate.id]))
          .limit(1);
        if (owner) continue;

        await deleteDocumentBlob(candidate.id, null);
        await deleteDocumentPreviewArtifacts(candidate.id, null);
        await deleteDocumentPreviewRows(candidate.id, null);
        reaped += 1;
      } catch (error) {
        failures.push(error);
        logDegraded(serverLogger, {
          event: 'tasks.reap_orphaned_blobs.delete_failed',
          msg: 'Failed to reap orphaned document storage',
          step: 'reap_orphaned_blob',
          context: { documentId: candidate.id },
          error,
        });
      } finally {
        await lease.release();
      }
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to reap ${failures.length} orphaned blob(s)`);
  }

  return {
    summary: `Reaped ${reaped} orphaned blob(s)`,
    scanned: blobs.length,
    candidates: candidates.length,
    reaped,
  };
}

import { inArray } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents } from '@openreader/database/schema';
import { isS3Configured } from '@/lib/server/storage/s3';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { deleteDocumentBlob, listDocumentSourceBlobs } from '@/lib/server/documents/blobstore';
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
 * Delete content-addressed document blobs that no longer have any owner, with
 * their derived artifacts and preview rows.
 *
 * Reference count = ownership rows in `documents`. A blob with zero rows and
 * age past the grace window is an orphan (e.g. left by a failed inline delete)
 * and is safe to remove. Derived artifacts whose source blob is already gone
 * (a job that finished after its source was reaped) are reaped the same way.
 * Production data is non-namespaced.
 */
export async function reapOrphanedBlobs(context: TaskContext): Promise<TaskResult> {
  if (!isS3Configured()) {
    return { summary: 'Skipped: object storage not configured', reaped: 0 };
  }
  if (!isComputeWorkerAvailable()) {
    return { summary: 'Skipped: compute worker not configured', reaped: 0 };
  }
  const client = getComputeWorkerClient();

  const now = Date.now();
  const blobs = await listDocumentSourceBlobs(null, { signal: context.signal });
  const blobIds = new Set(blobs.map((blob) => blob.id));
  const { documentIds: derivedIds } = await client.listDocumentDerivedIds({ signal: context.signal });
  const candidates = [
    ...blobs.filter((blob) => now - blob.lastModifiedMs > GRACE_MS).map((blob) => blob.id),
    ...derivedIds.filter((id) => !blobIds.has(id)),
  ];

  let reaped = 0;
  const failures: unknown[] = [];
  for (let i = 0; i < candidates.length; i += OWNERSHIP_CHECK_BATCH) {
    context.signal.throwIfAborted();
    const ids = candidates.slice(i, i + OWNERSHIP_CHECK_BATCH);
    const ownedRows = await db
      .select({ id: documents.id })
      .from(documents)
      .where(inArray(documents.id, ids));
    const owned = new Set(ownedRows.map((row: { id: string }) => row.id));

    for (const documentId of ids) {
      context.signal.throwIfAborted();
      if (owned.has(documentId)) continue;
      const lease = await tryAcquireDocumentBlobLease(documentId);
      if (!lease) continue;
      try {
        const [owner] = await db
          .select({ id: documents.id })
          .from(documents)
          .where(inArray(documents.id, [documentId]))
          .limit(1);
        if (owner) continue;

        await Promise.all([
          client.clearPdfLayoutArtifacts({ documentId, namespace: null }, { signal: context.signal }),
          client.clearDocumentPreviewArtifacts({ documentId, namespace: null }, { signal: context.signal }),
          client.clearTtsPlaybackPlans({ documentId }, { signal: context.signal }),
        ]);
        // The source blob goes last: while it exists the document stays a
        // candidate, so a failure in any earlier step is retried next run.
        await deleteDocumentPreviewRows(documentId, null);
        if (blobIds.has(documentId)) await deleteDocumentBlob(documentId, null);
        reaped += 1;
      } catch (error) {
        failures.push(error);
        logDegraded(serverLogger, {
          event: 'tasks.reap_orphaned_blobs.delete_failed',
          msg: 'Failed to reap orphaned document storage',
          step: 'reap_orphaned_blob',
          context: { documentId },
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
    summary: `Reaped ${reaped} orphaned document(s)`,
    scanned: blobs.length,
    candidates: candidates.length,
    reaped,
  };
}

import { and, eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents } from '@openreader/database/schema';
import { deleteDocumentTtsSegmentCache } from '@/lib/server/tts/segments-cache';
import { enqueueStorageCleanup, runStorageCleanup } from '@/lib/server/storage/cleanups';
import { hashForLog, serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';

// The inline run normally settles the queued row; the retry task only takes it
// over after this delay, so it never sees the document before the delete lands.
const QUEUED_CLEANUP_RETRY_DELAY_MS = 5 * 60 * 1000;

/**
 * Remove a user's ownership of a document.
 *
 * Only the per-user playback storage is cleaned (it is keyed by userId and not
 * reachable afterwards). Its cleanup is queued before the row delete, so a
 * crash in between still leaves a row the `retry-storage-cleanups` task runs,
 * and is then run inline. No transaction is held: SQLite would keep its write
 * lock across the awaits. The shared, content-addressed document blob and its
 * previews are reclaimed by the `reap-orphaned-blobs` task once no owner remains.
 */
export async function deleteOwnedDocument(input: {
  userId: string;
  documentId: string;
  namespace: string | null;
  scheduleCleanup?: (task: () => Promise<void>) => void;
}): Promise<boolean> {
  const queued = input.namespace === null
    ? await enqueueStorageCleanup({
      userId: input.userId,
      documentId: input.documentId,
      notBeforeMs: Date.now() + QUEUED_CLEANUP_RETRY_DELAY_MS,
    })
    : null;
  const [removed] = await db
    .delete(documents)
    .where(and(
      eq(documents.id, input.documentId),
      eq(documents.userId, input.userId),
    ))
    .returning();
  // A delete that removed nothing leaves the queued row to the retry task: it
  // may be an earlier delete's cleanup that has not succeeded yet.
  if (!removed) return false;

  const cleanPlaybackCache = async () => {
    if (queued) {
      await runStorageCleanup(queued);
      return;
    }
    await deleteDocumentTtsSegmentCache(input).catch((error) => {
      logDegraded(serverLogger, {
        event: 'documents.delete_owned.tts_cache_cleanup.failed',
        msg: 'Failed to clean TTS segment cache after document deletion',
        step: 'delete_document_tts_segment_cache',
        context: { documentId: input.documentId, userIdHash: hashForLog(input.userId) },
        error,
      });
    });
  };

  if (input.scheduleCleanup) {
    input.scheduleCleanup(cleanPlaybackCache);
  } else {
    await cleanPlaybackCache();
  }

  return true;
}

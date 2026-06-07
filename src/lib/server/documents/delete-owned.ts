import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { documents } from '@/db/schema';
import { deleteDocumentTtsSegmentCache } from '@/lib/server/tts/segments-cache';
import { hashForLog, serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';

/**
 * Remove a user's ownership of a document.
 *
 * Only the per-user TTS segment cache is cleaned inline (it is keyed by userId
 * and not reachable afterwards). The shared, content-addressed document blob and
 * its previews are reclaimed by the `reap-orphaned-blobs` task once no owner
 * remains, so there is no inline blob deletion, last-owner check, or lock.
 */
export async function deleteOwnedDocument(input: {
  userId: string;
  documentId: string;
  namespace: string | null;
}): Promise<boolean> {
  const [removed] = await db
    .delete(documents)
    .where(and(
      eq(documents.id, input.documentId),
      eq(documents.userId, input.userId),
    ))
    .returning();
  if (!removed) return false;

  await deleteDocumentTtsSegmentCache(input).catch((error) => {
    logDegraded(serverLogger, {
      event: 'documents.delete_owned.tts_cache_cleanup.failed',
      msg: 'Failed to clean TTS segment cache after document deletion',
      step: 'delete_document_tts_segment_cache',
      context: { documentId: input.documentId, userIdHash: hashForLog(input.userId) },
      error,
    });
  });

  return true;
}

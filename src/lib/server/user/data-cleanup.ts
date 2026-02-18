/**
 * Cleans up all S3 storage artifacts belonging to a user.
 * Called from Better Auth's `beforeDelete` hook so that blobs are removed
 * before the DB cascade wipes the metadata rows we query against.
 */

import { db } from '@/db';
import { documents, audiobooks } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { isS3Configured } from '@/lib/server/storage/s3';
import { deleteDocumentBlob } from '@/lib/server/documents/blobstore';
import { deleteDocumentPreviewArtifacts } from '@/lib/server/documents/previews-blobstore';
import { audiobookPrefix, deleteAudiobookPrefix } from '@/lib/server/audiobooks/blobstore';

type DocumentRow = { id: string };
type AudiobookRow = { id: string };

/**
 * Delete all S3 blobs owned by `userId`.
 *
 * This covers:
 *  - Document file blobs
 *  - Document preview images
 *  - Audiobook audio files (chapter mp3s, metadata json, etc.)
 *
 * Each item is cleaned up independently; a failure on one does not block the rest.
 */
export async function deleteUserStorageData(
  userId: string,
  namespace: string | null,
): Promise<void> {
  if (!isS3Configured()) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const database = db as any;

  // --- Documents & previews ---
  const userDocs: DocumentRow[] = await database
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.userId, userId));

  let docsDeleted = 0;
  for (const doc of userDocs) {
    try {
      await deleteDocumentBlob(doc.id, namespace);
      docsDeleted++;
    } catch (error) {
      console.error(`[user-data-cleanup] Failed to delete document blob ${doc.id}:`, error);
    }

    try {
      await deleteDocumentPreviewArtifacts(doc.id, namespace);
    } catch (error) {
      console.error(`[user-data-cleanup] Failed to delete preview for ${doc.id}:`, error);
    }
  }

  // --- Audiobooks ---
  const userBooks: AudiobookRow[] = await database
    .select({ id: audiobooks.id })
    .from(audiobooks)
    .where(eq(audiobooks.userId, userId));

  let booksDeleted = 0;
  for (const book of userBooks) {
    try {
      const prefix = audiobookPrefix(book.id, userId, namespace);
      await deleteAudiobookPrefix(prefix);
      booksDeleted++;
    } catch (error) {
      console.error(`[user-data-cleanup] Failed to delete audiobook blobs ${book.id}:`, error);
    }
  }

  if (docsDeleted > 0 || booksDeleted > 0) {
    console.log(
      `[user-data-cleanup] Cleaned up S3 data for user ${userId}: ` +
      `${docsDeleted}/${userDocs.length} document(s), ` +
      `${booksDeleted}/${userBooks.length} audiobook(s)`,
    );
  }
}

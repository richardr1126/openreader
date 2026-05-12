/**
 * Cleans up all S3 storage artifacts belonging to a user.
 * Called from Better Auth's `beforeDelete` hook so that blobs are removed
 * before the DB cascade wipes the metadata rows we query against.
 */

import { db } from '@/db';
import { documents, audiobooks } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getS3Config, isS3Configured } from '@/lib/server/storage/s3';
import { deleteDocumentBlob } from '@/lib/server/documents/blobstore';
import { deleteDocumentPreviewArtifacts } from '@/lib/server/documents/previews-blobstore';
import { deleteDocumentPreviewRows } from '@/lib/server/documents/previews';
import { audiobookPrefix, deleteAudiobookPrefix } from '@/lib/server/audiobooks/blobstore';
import { deleteTtsSegmentPrefix } from '@/lib/server/tts/segments-blobstore';

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
  const s3Enabled = isS3Configured();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const database = db as any;

  // --- Documents & previews ---
  const userDocs: DocumentRow[] = await database
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.userId, userId));

  let docsDeleted = 0;
  for (const doc of userDocs) {
    if (s3Enabled) {
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

    // Always clean up DB rows — documentPreviews has no FK cascade on user.
    try {
      await deleteDocumentPreviewRows(doc.id, namespace);
    } catch (error) {
      console.error(`[user-data-cleanup] Failed to delete preview rows for ${doc.id}:`, error);
    }
  }

  // --- Audiobooks ---
  const userBooks: AudiobookRow[] = s3Enabled
    ? await database
        .select({ id: audiobooks.id })
        .from(audiobooks)
        .where(eq(audiobooks.userId, userId))
    : [];

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

  // --- TTS segments ---
  let segmentsDeleted = 0;
  if (s3Enabled) {
    try {
      const cfg = getS3Config();
      const nsSegment = namespace ? `ns/${namespace}/` : '';
      const ttsPrefixV1 = `${cfg.prefix}/tts_segments_v1/${nsSegment}users/${encodeURIComponent(userId)}/`;
      const ttsPrefixV2 = `${cfg.prefix}/tts_segments_v2/${nsSegment}users/${encodeURIComponent(userId)}/`;
      segmentsDeleted += await deleteTtsSegmentPrefix(ttsPrefixV1);
      segmentsDeleted += await deleteTtsSegmentPrefix(ttsPrefixV2);
    } catch (error) {
      console.error(`[user-data-cleanup] Failed to delete TTS segment blobs for user ${userId}:`, error);
    }
  }

  if (docsDeleted > 0 || booksDeleted > 0 || segmentsDeleted > 0) {
    console.log(
      `[user-data-cleanup] Cleaned up S3 data for user ${userId}: ` +
      `${docsDeleted}/${userDocs.length} document(s), ` +
      `${booksDeleted}/${userBooks.length} audiobook(s), ` +
      `${segmentsDeleted} tts segment object(s)`,
    );
  }
}

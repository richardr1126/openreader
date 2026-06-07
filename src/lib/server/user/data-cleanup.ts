/**
 * Cleans up all S3 storage artifacts belonging to a user.
 * Called from Better Auth's `beforeDelete` hook so that blobs are removed
 * before the DB cascade wipes the metadata rows we query against.
 */

import { db } from '@/db';
import { documents, audiobooks, userJobEvents, userTtsChars } from '@/db/schema';
import * as authSchemaSqlite from '@/db/schema_auth_sqlite';
import * as authSchemaPostgres from '@/db/schema_auth_postgres';
import { and, eq, ne } from 'drizzle-orm';
import { getS3Config, isS3Configured } from '@/lib/server/storage/s3';
import {
  deleteDocumentBlob,
  deleteDocumentPrefix,
  tempDocumentUploadPrefix,
} from '@/lib/server/documents/blobstore';
import { deleteDocumentPreviewArtifacts } from '@/lib/server/documents/previews-blobstore';
import { deleteDocumentPreviewRows } from '@/lib/server/documents/previews';
import { audiobookPrefix, deleteAudiobookPrefix } from '@/lib/server/audiobooks/blobstore';
import { deleteTtsSegmentPrefix } from '@/lib/server/tts/segments-blobstore';
import { hashForLog, serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';
import { withDocumentLock } from '@/lib/server/documents/document-lock';

type DocumentRow = typeof documents.$inferSelect;
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
  const failures: unknown[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const database = db as any;
  const authSchema = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;

  // --- Documents & previews ---
  const userDocs: DocumentRow[] = await database
    .select()
    .from(documents)
    .where(eq(documents.userId, userId));

  let docsDeleted = 0;
  const removedDocs: DocumentRow[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const restoreRemovedDocs = async (conn: any = database) => {
    if (removedDocs.length === 0) return;
    const docsToRestore = [...removedDocs];
    await conn.insert(documents).values(docsToRestore).onConflictDoNothing();
    removedDocs.length = 0;
  };
  // Restore before throwing the diagnostic AggregateError, but never let a
  // restore failure replace the original cleanup failures we want to surface.
  const tryRestoreRemovedDocs = async () => {
    try {
      await restoreRemovedDocs();
    } catch (error) {
      logDegraded(serverLogger, {
        event: 'user.data_cleanup.restore_removed_docs.failed',
        msg: 'Failed to restore document rows after cleanup failure',
        step: 'restore_removed_docs',
        context: { userIdHash: hashForLog(userId) },
        error,
      });
    }
  };
  // The mutation lock already serializes all mutations for this document, so a
  // plain read-modify-write is safe without an inner transaction or FOR UPDATE.
  const removeOwnershipAndCheckLastOwner = async (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conn: any,
    doc: DocumentRow,
  ) => {
    const [removedDoc] = await conn
      .delete(documents)
      .where(and(eq(documents.id, doc.id), eq(documents.userId, userId)))
      .returning();
    if (!removedDoc) return { removedDoc: null, isLastOwner: false };

    const otherOwners = await conn
      .select({ id: documents.id })
      .from(documents)
      .where(and(
        eq(documents.id, doc.id),
        ne(documents.userId, userId),
      ))
      .limit(1);
    return { removedDoc, isLastOwner: otherOwners.length === 0 };
  };

  for (const doc of userDocs) {
    await withDocumentLock(doc.id, async (conn) => {
      const { removedDoc, isLastOwner } = await removeOwnershipAndCheckLastOwner(conn, doc);
      if (!removedDoc) return;
      removedDocs.push(removedDoc);

      if (s3Enabled && isLastOwner) {
        try {
          await deleteDocumentPreviewArtifacts(doc.id, namespace);
        } catch (error) {
          failures.push(error);
          logDegraded(serverLogger, {
            event: 'user.data_cleanup.document_preview_delete.failed',
            msg: 'Failed to delete preview artifacts',
            step: 'delete_document_preview_artifacts',
            context: {
              documentId: doc.id,
              userIdHash: hashForLog(userId),
            },
            error,
          });
        }
      }

      // Preview metadata is global, so only the canonical final-owner pass may
      // remove it.
      if (namespace === null && isLastOwner) {
        try {
          await deleteDocumentPreviewRows(doc.id, namespace);
        } catch (error) {
          failures.push(error);
          logDegraded(serverLogger, {
            event: 'user.data_cleanup.document_preview_rows_delete.failed',
            msg: 'Failed to delete preview rows',
            step: 'delete_document_preview_rows',
            context: {
              documentId: doc.id,
              userIdHash: hashForLog(userId),
            },
            error,
          });
        }
      }

      if (s3Enabled && isLastOwner) {
        try {
          await deleteDocumentBlob(doc.id, namespace);
          docsDeleted++;
        } catch (error) {
          failures.push(error);
          logDegraded(serverLogger, {
            event: 'user.data_cleanup.document_blob_delete.failed',
            msg: 'Failed to delete document blob',
            step: 'delete_document_blob',
            context: {
              documentId: doc.id,
              userIdHash: hashForLog(userId),
            },
            error,
          });
        }
      }

      if (namespace !== null) {
        await restoreRemovedDocs(conn);
      }
    });
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
      failures.push(error);
      logDegraded(serverLogger, {
        event: 'user.data_cleanup.audiobook_blobs_delete.failed',
        msg: 'Failed to delete audiobook blobs',
        step: 'delete_audiobook_prefix',
        context: {
          bookId: book.id,
          userIdHash: hashForLog(userId),
        },
        error,
      });
    }
  }

  // --- TTS segments ---
  let segmentsDeleted = 0;
  if (s3Enabled) {
    try {
      await deleteDocumentPrefix(tempDocumentUploadPrefix(userId, namespace));
    } catch (error) {
      failures.push(error);
      logDegraded(serverLogger, {
        event: 'user.data_cleanup.temp_document_uploads_delete.failed',
        msg: 'Failed to delete temporary document uploads',
        step: 'delete_temp_document_upload_prefix',
        context: { userIdHash: hashForLog(userId) },
        error,
      });
    }

    try {
      const cfg = getS3Config();
      const nsSegment = namespace ? `ns/${namespace}/` : '';
      const ttsPrefixV1 = `${cfg.prefix}/tts_segments_v1/${nsSegment}users/${encodeURIComponent(userId)}/`;
      const ttsPrefixV2 = `${cfg.prefix}/tts_segments_v2/${nsSegment}users/${encodeURIComponent(userId)}/`;
      segmentsDeleted += await deleteTtsSegmentPrefix(ttsPrefixV1);
      segmentsDeleted += await deleteTtsSegmentPrefix(ttsPrefixV2);
    } catch (error) {
      failures.push(error);
      logDegraded(serverLogger, {
        event: 'user.data_cleanup.tts_segments_delete.failed',
        msg: 'Failed to delete TTS segment blobs',
        step: 'delete_tts_segment_prefixes',
        context: { userIdHash: hashForLog(userId) },
        error,
      });
    }
  }

  if (failures.length > 0) {
    await tryRestoreRemovedDocs();
    throw new AggregateError(failures, `User storage cleanup failed in ${failures.length} operation(s)`);
  }

  // Namespaced cleanup is an additional storage pass made by the account
  // route. Database rows are global and must only be removed during the
  // canonical non-namespaced beforeDelete pass.
  if (namespace === null) {
    // Delete explicitly for compatibility with pre-cascade installations and
    // to remove auth verification tokens, which cannot carry a user FK.
    for (const { table, userColumn, step } of [
      { table: userTtsChars, userColumn: userTtsChars.userId, step: 'delete_user_tts_usage_rows' },
      { table: userJobEvents, userColumn: userJobEvents.userId, step: 'delete_user_job_event_rows' },
      { table: authSchema.verification, userColumn: authSchema.verification.value, step: 'delete_user_verification_rows' },
    ]) {
      await database.delete(table).where(eq(userColumn, userId)).catch((error: unknown) => {
        failures.push(error);
        logDegraded(serverLogger, {
          event: 'user.data_cleanup.db_rows_delete.failed',
          msg: 'Failed to delete non-cascading user database rows',
          step,
          context: { userIdHash: hashForLog(userId) },
          error,
        });
      });
    }
  }

  if (docsDeleted > 0 || booksDeleted > 0 || segmentsDeleted > 0) {
    serverLogger.info({
      event: 'user.data_cleanup.completed',
      userIdHash: hashForLog(userId),
      docsDeleted,
      totalDocs: userDocs.length,
      booksDeleted,
      totalBooks: userBooks.length,
      segmentsDeleted,
    }, 'Completed user storage cleanup');
  }

  if (failures.length > 0) {
    await tryRestoreRemovedDocs();
    throw new AggregateError(failures, `User database cleanup failed in ${failures.length} operation(s)`);
  }
}

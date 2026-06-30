/**
 * Cleans up user-scoped storage that the orphaned-blob reaper cannot reach.
 *
 * Called from Better Auth's `beforeDelete` hook (canonical pass) and the
 * account-delete route (test-namespaced pass). Shared, content-addressed
 * document blobs + previews are NOT deleted here on the canonical pass — they
 * are reclaimed by the `reap-orphaned-blobs` task once their ownership rows are
 * gone. Per-user storage (TTS segments, temp uploads) is keyed by
 * userId and would be unreachable after the cascade, so it is deleted inline
 * and failures block the deletion.
 */

import { db } from '@openreader/database';
import { documents, userJobEvents, userTtsChars } from '@openreader/database/schema';
import * as authSchemaSqlite from '@openreader/database/schema-auth-sqlite';
import * as authSchemaPostgres from '@openreader/database/schema-auth-postgres';
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { getS3Config, isS3Configured } from '@/lib/server/storage/s3';
import {
  deleteDocumentBlob,
  deleteDocumentPrefix,
  tempDocumentUploadPrefix,
} from '@/lib/server/documents/blobstore';
import { deleteDocumentPreviewArtifacts } from '@/lib/server/documents/previews-blobstore';
import { deleteDocumentPreviewRows } from '@/lib/server/documents/previews';
import { deleteTtsSegmentPrefix } from '@/lib/server/tts/segments-blobstore';
import { hashForLog, serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';

function storageUserHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}

export async function deleteUserStorageData(
  userId: string,
  namespace: string | null,
): Promise<void> {
  const s3Enabled = isS3Configured();
  const failures: unknown[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const database = db as any;
  const authSchema = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;

  // --- Document blobs & previews ---
  // Canonical pass: deferred to the reap-orphaned-blobs task (the rows cascade
  // away with the user, then the reaper reclaims the now-orphaned blobs). The
  // reaper only runs for the canonical namespace, so test-namespaced storage is
  // deleted inline here.
  let docBlobsDeleted = 0;
  if (s3Enabled && namespace !== null) {
    const userDocs = (await database
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.userId, userId))) as Array<{ id: string }>;
    for (const doc of userDocs) {
      try {
        await deleteDocumentBlob(doc.id, namespace);
        await deleteDocumentPreviewArtifacts(doc.id, namespace);
        await deleteDocumentPreviewRows(doc.id, namespace);
        docBlobsDeleted++;
      } catch (error) {
        failures.push(error);
        logDegraded(serverLogger, {
          event: 'user.data_cleanup.document_storage_delete.failed',
          msg: 'Failed to delete namespaced document storage',
          step: 'delete_namespaced_document_storage',
          context: { documentId: doc.id, userIdHash: hashForLog(userId) },
          error,
        });
      }
    }
  }

  // --- Temp uploads + TTS segments (per-user object storage; not reaped) ---
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
      const playbackAudioPrefix = `${cfg.prefix}/tts_playback_segments_audio_v1/${nsSegment}users/${encodeURIComponent(userId)}/`;
      segmentsDeleted += await deleteTtsSegmentPrefix(playbackAudioPrefix);
      if (namespace === null) {
        const playbackSidecarPrefix = `${cfg.prefix}/tts_playback_segments_v1/users/${storageUserHash(userId)}/`;
        segmentsDeleted += await deleteTtsSegmentPrefix(playbackSidecarPrefix);
      }
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

  // Block deletion if any non-reapable storage cleanup failed — proceeding
  // would permanently orphan it. Nothing was removed from the database yet, so
  // there is nothing to roll back.
  if (failures.length > 0) {
    throw new AggregateError(failures, `User storage cleanup failed in ${failures.length} operation(s)`);
  }

  // Namespaced cleanup is a storage-only pass; database rows are global and are
  // only removed on the canonical (non-namespaced) pass.
  if (namespace === null) {
    // Explicit for compatibility with pre-cascade installations and to remove
    // auth verification tokens, which cannot carry a user FK.
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

  if (docBlobsDeleted > 0 || segmentsDeleted > 0) {
    serverLogger.info({
      event: 'user.data_cleanup.completed',
      userIdHash: hashForLog(userId),
      docBlobsDeleted,
      segmentsDeleted,
    }, 'Completed user storage cleanup');
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `User database cleanup failed in ${failures.length} operation(s)`);
  }
}

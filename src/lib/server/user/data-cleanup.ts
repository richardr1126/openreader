/**
 * Cleans up user-scoped storage that the orphaned-blob reaper cannot reach.
 *
 * Called from Better Auth's `beforeDelete` hook (canonical pass) and the
 * account-delete route (test-namespaced pass). Shared, content-addressed
 * document blobs + previews are NOT deleted here on the canonical pass — they
 * are reclaimed by the `reap-orphaned-blobs` task once their ownership rows are
 * gone. Per-user storage (TTS segments, temp uploads) is keyed by
 * userId and would be unreachable after the cascade, so the compute worker
 * deletes it before deletion is allowed to proceed.
 */

import { db } from '@openreader/database';
import { documents, userJobEvents, userTtsChars } from '@openreader/database/schema';
import * as authSchemaSqlite from '@openreader/database/schema-auth-sqlite';
import * as authSchemaPostgres from '@openreader/database/schema-auth-postgres';
import { eq } from 'drizzle-orm';
import { isS3Configured } from '@/lib/server/storage/s3';
import { deleteDocumentPreviewRows } from '@/lib/server/documents/previews';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { hashForLog, serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';

export async function deleteUserStorageData(
  userId: string,
  namespace: string | null,
): Promise<void> {
  const s3Enabled = isS3Configured();
  const failures: unknown[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const database = db as any;
  const authSchema = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;

  // Canonical shared document blobs remain reaper-owned after the SQL cascade.
  // Test-namespaced document artifacts and all per-user storage are deleted by
  // the compute worker, never by a Next request.
  let docBlobsDeleted = 0;
  let userStorageObjectsDeleted = 0;
  if (s3Enabled) {
    if (!isComputeWorkerAvailable()) {
      failures.push(new Error('Compute worker is required for user storage cleanup'));
    } else {
      const userDocs = namespace !== null
        ? (await database
          .select({ id: documents.id })
          .from(documents)
          .where(eq(documents.userId, userId))) as Array<{ id: string }>
        : [];

      for (let index = 0; index < userDocs.length || index === 0; index += 100) {
        const documentIds = userDocs.slice(index, index + 100).map((doc) => doc.id);
        if (index > 0 && documentIds.length === 0) break;
        try {
          const result = await getComputeWorkerClient().cleanupUserStorage({
            storageUserId: userId,
            namespace,
            documentIds,
          });
          userStorageObjectsDeleted += result.deletedObjects;
          docBlobsDeleted += result.deletedDocumentArtifacts;
        } catch (error) {
          failures.push(error);
          logDegraded(serverLogger, {
            event: 'user.data_cleanup.worker_storage_delete.failed',
            msg: 'Failed to delete user storage through compute worker',
            step: 'delete_user_storage_worker',
            context: { userIdHash: hashForLog(userId) },
            error,
          });
        }
        if (userDocs.length === 0) break;
      }

      if (namespace !== null) {
        for (const doc of userDocs) {
          await deleteDocumentPreviewRows(doc.id, namespace).catch((error) => {
            failures.push(error);
            logDegraded(serverLogger, {
              event: 'user.data_cleanup.document_preview_rows_delete.failed',
              msg: 'Failed to delete namespaced document preview rows',
              step: 'delete_namespaced_document_preview_rows',
              context: { documentId: doc.id, userIdHash: hashForLog(userId) },
              error,
            });
          });
        }
      }
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

  if (docBlobsDeleted > 0 || userStorageObjectsDeleted > 0) {
    serverLogger.info({
      event: 'user.data_cleanup.completed',
      userIdHash: hashForLog(userId),
      docBlobsDeleted,
      userStorageObjectsDeleted,
    }, 'Completed user storage cleanup');
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `User database cleanup failed in ${failures.length} operation(s)`);
  }
}

/**
 * SQL side of account deletion, run by `finalizeUserDeletion` after the
 * `delete-users` worker job has removed the account's per-user storage.
 * Shared, content-addressed document blobs and previews are reclaimed by the
 * `reap-orphaned-blobs` task once their ownership rows are gone.
 */

import { db } from '@openreader/database';
import { computeLimitBuckets } from '@openreader/database/schema';
import * as authSchemaSqlite from '@openreader/database/schema-auth-sqlite';
import * as authSchemaPostgres from '@openreader/database/schema-auth-postgres';
import { and, eq } from 'drizzle-orm';
import { isS3Configured } from '@/lib/server/storage/s3';
import { hashForLog, serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';
import { deriveComputeScopeKey } from '@/lib/server/compute-limits/policy';
import { enqueueStorageCleanup } from '@/lib/server/storage/cleanups';

const ACCOUNT_CLEANUP_SECOND_PASS_DELAY_MS = 15 * 60 * 1000;

/** SQL-only completion after the worker has removed user storage. Idempotent. */
export async function deleteUserDatabaseData(userId: string): Promise<void> {
  const s3Enabled = isS3Configured();
  const failures: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const database = db as any;
  const authSchema = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;
  // A playback job that was mid-write can land an object after the sweep
  // above. A delayed second pass clears it once the account row is gone; if
  // the delete is abandoned the queued row sees the user and drops itself.
  if (s3Enabled) {
    await enqueueStorageCleanup({
      userId,
      documentId: null,
      notBeforeMs: Date.now() + ACCOUNT_CLEANUP_SECOND_PASS_DELAY_MS,
    });
  }

  await database.delete(computeLimitBuckets).where(and(
    eq(computeLimitBuckets.scopeType, 'user'),
    eq(computeLimitBuckets.scopeKey, deriveComputeScopeKey('user', userId)),
  )).catch((error: unknown) => {
    failures.push(error);
    logDegraded(serverLogger, {
      event: 'user.data_cleanup.db_rows_delete.failed',
      msg: 'Failed to delete user compute-limit buckets',
      step: 'delete_user_compute_limit_buckets',
      context: { userIdHash: hashForLog(userId) },
      error,
    });
  });

  // Explicit for compatibility with pre-cascade installations and to remove
  // auth verification tokens, which cannot carry a user FK.
  for (const { table, userColumn, step } of [
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
  if (failures.length > 0) {
    throw new AggregateError(failures, `User database cleanup failed in ${failures.length} operation(s)`);
  }
}

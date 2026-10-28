import { and, asc, eq, lte } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents, storageCleanups } from '@openreader/database/schema';
import * as authSchemaSqlite from '@openreader/database/schema-auth-sqlite';
import * as authSchemaPostgres from '@openreader/database/schema-auth-postgres';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { deleteDocumentTtsSegmentCache } from '@/lib/server/tts/segments-cache';
import { hashForLog, serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';

/**
 * Durable queue of user-scoped object storage the compute worker still has to
 * delete. A row is written with the delete that makes its storage unreachable
 * and removed once the worker clear succeeds, so a failed or interrupted
 * cleanup is retried by the `retry-storage-cleanups` task instead of leaving
 * orphaned objects. Only canonical storage is queued: test namespaces clean
 * their own isolated prefixes inline.
 */

const authSchema = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;
const RETRY_BASE_MS = 5 * 60 * 1000;
const RETRY_MAX_MS = 24 * 60 * 60 * 1000;

export type StorageCleanupRow = {
  id: string;
  userId: string;
  documentId: string | null;
  notBeforeMs: number;
  attempts: number;
};

export function storageCleanupId(userId: string, documentId: string | null): string {
  return documentId === null ? `user:${userId}` : `doc:${userId}:${documentId}`;
}

/** Queue (or re-arm) cleanup of one user's document storage, or of the whole user when `documentId` is null. */
export async function enqueueStorageCleanup(
  input: { userId: string; documentId: string | null; notBeforeMs?: number },
): Promise<StorageCleanupRow> {
  const now = Date.now();
  const row = {
    id: storageCleanupId(input.userId, input.documentId),
    userId: input.userId,
    documentId: input.documentId,
    notBeforeMs: input.notBeforeMs ?? now,
    attempts: 0,
  };
  await db
    .insert(storageCleanups)
    .values({ ...row, createdAtMs: now })
    .onConflictDoUpdate({
      target: storageCleanups.id,
      set: { notBeforeMs: row.notBeforeMs, attempts: 0, lastError: null },
    });
  return row;
}

async function isStillOwned(row: StorageCleanupRow): Promise<boolean> {
  if (row.documentId === null) {
    const [user] = await db.select({ id: authSchema.user.id }).from(authSchema.user)
      .where(eq(authSchema.user.id, row.userId)).limit(1);
    return Boolean(user);
  }
  const [owned] = await db.select({ id: documents.id }).from(documents)
    .where(and(eq(documents.id, row.documentId), eq(documents.userId, row.userId))).limit(1);
  return Boolean(owned);
}

// Removing only the claimed generation keeps a row re-armed during the run.
async function settleRow(row: StorageCleanupRow): Promise<void> {
  await db.delete(storageCleanups).where(and(
    eq(storageCleanups.id, row.id),
    eq(storageCleanups.notBeforeMs, row.notBeforeMs),
  ));
}

/** Drop a row queued for a delete that turned out to remove nothing. */
export async function discardStorageCleanup(row: StorageCleanupRow): Promise<void> {
  await settleRow(row);
}

/**
 * Run one queued cleanup. The row is dropped without a worker call when the
 * user owns the document (or the account exists) again, since its storage is
 * live; a failure backs the row off for the retry task.
 */
export async function runStorageCleanup(row: StorageCleanupRow): Promise<'cleared' | 'owned' | 'failed'> {
  try {
    if (await isStillOwned(row)) {
      await settleRow(row);
      return 'owned';
    }
    if (!isComputeWorkerAvailable()) throw new Error('Compute worker is required for storage cleanup');
    if (row.documentId === null) {
      await getComputeWorkerClient().cleanupUserStorage({
        storageUserId: row.userId,
        namespace: null,
        documentIds: [],
      });
    } else {
      await deleteDocumentTtsSegmentCache({ userId: row.userId, documentId: row.documentId, namespace: null });
    }
    await settleRow(row);
    return 'cleared';
  } catch (error) {
    const attempts = row.attempts + 1;
    // If the backoff cannot be recorded either, the row keeps its due time and
    // the retry task picks it up; this runs after responses, so never reject.
    await db.update(storageCleanups).set({
      attempts,
      lastError: String(error).slice(0, 1000),
      notBeforeMs: Date.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1)),
    }).where(and(
      eq(storageCleanups.id, row.id),
      eq(storageCleanups.notBeforeMs, row.notBeforeMs),
    )).catch(() => undefined);
    logDegraded(serverLogger, {
      event: 'storage.cleanup.failed',
      msg: 'Queued storage cleanup failed; it will be retried',
      step: row.documentId === null ? 'cleanup_user_storage' : 'cleanup_document_storage',
      context: { userIdHash: hashForLog(row.userId), documentId: row.documentId, attempts },
      error,
    });
    return 'failed';
  }
}

/** Run due cleanups oldest first until the queue is drained or the deadline passes. */
export async function drainStorageCleanups(input: { deadlineAt: number; signal?: AbortSignal }): Promise<{
  cleared: number;
  owned: number;
  failed: number;
  remaining: boolean;
}> {
  const totals = { cleared: 0, owned: 0, failed: 0 };
  const attempted = new Set<string>();
  while (Date.now() < input.deadlineAt && !input.signal?.aborted) {
    const due = (await db.select({
      id: storageCleanups.id,
      userId: storageCleanups.userId,
      documentId: storageCleanups.documentId,
      notBeforeMs: storageCleanups.notBeforeMs,
      attempts: storageCleanups.attempts,
    }).from(storageCleanups)
      .where(lte(storageCleanups.notBeforeMs, Date.now()))
      .orderBy(asc(storageCleanups.notBeforeMs))
      .limit(25) as StorageCleanupRow[]).filter((row) => !attempted.has(row.id));
    if (due.length === 0) return { ...totals, remaining: false };
    for (const row of due) {
      if (Date.now() >= input.deadlineAt || input.signal?.aborted) break;
      attempted.add(row.id);
      totals[await runStorageCleanup(row)] += 1;
    }
  }
  return { ...totals, remaining: true };
}

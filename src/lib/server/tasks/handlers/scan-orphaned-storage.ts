// ONE-TIME: clears the user-scoped storage left behind before document and
// account deletes queued their cleanup (`storage_cleanups`). It disables itself
// after one complete pass. Remove this handler, its registry entry, the worker
// `/v1/user-storage/scopes` and `/v1/user-storage/sidecars/clear` routes, and
// their client methods once deployments have run it.
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents } from '@openreader/database/schema';
import * as authSchemaSqlite from '@openreader/database/schema-auth-sqlite';
import * as authSchemaPostgres from '@openreader/database/schema-auth-postgres';
import { isS3Configured } from '@/lib/server/storage/s3';
import {
  getComputeWorkerClient,
  isComputeWorkerAvailable,
  type UserStorageScopeRoot,
} from '@/lib/server/compute-worker/client';
import { enqueueStorageCleanup } from '@/lib/server/storage/cleanups';
import type { TaskContext, TaskResult } from '../types';

const authSchema = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;
const ROOTS: UserStorageScopeRoot[] = [
  'playback-audio',
  'playback-exports',
  'playback-sidecars',
  'account-exports',
  'cloned-voices',
];
const PAGE_SIZE = 100;
const DEADLINE_HEADROOM_MS = 10_000;

type ScanCursor = { root: number; after: string | null };

function parseCursor(raw: string | null): ScanCursor {
  if (!raw) return { root: 0, after: null };
  try {
    const parsed = JSON.parse(raw) as Partial<ScanCursor>;
    const root = Number(parsed.root);
    if (Number.isInteger(root) && root >= 0 && root < ROOTS.length) {
      return { root, after: typeof parsed.after === 'string' ? parsed.after : null };
    }
  } catch {
    // Start over from a cursor this version cannot read.
  }
  return { root: 0, after: null };
}

async function existingUserIds(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db.select({ id: authSchema.user.id }).from(authSchema.user)
    .where(inArray(authSchema.user.id, userIds)) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

// Sidecar folders are named by sha256(user id), so map every account's hash.
async function userIdsByStorageHash(): Promise<Map<string, string>> {
  const rows = await db.select({ id: authSchema.user.id }).from(authSchema.user) as Array<{ id: string }>;
  return new Map(rows.map((row) => [createHash('sha256').update(row.id).digest('hex'), row.id]));
}

export async function scanOrphanedStorage(context: TaskContext): Promise<TaskResult> {
  if (!isS3Configured()) {
    return { summary: 'Skipped: object storage not configured' };
  }
  if (!isComputeWorkerAvailable()) {
    return { summary: 'Skipped: compute worker not configured' };
  }
  const client = getComputeWorkerClient();
  const cursor = parseCursor(context.cursor);
  const totals = { scannedUsers: 0, queuedAccounts: 0, queuedDocuments: 0, clearedSidecarUsers: 0 };
  let hashes: Map<string, string> | null = null;

  while (cursor.root < ROOTS.length) {
    if (Date.now() >= context.deadlineAt - DEADLINE_HEADROOM_MS || context.signal.aborted) {
      return {
        summary: `Scanned ${totals.scannedUsers} user folder(s); more remain`,
        cursor: JSON.stringify(cursor),
        ...totals,
      };
    }
    const root = ROOTS[cursor.root];
    const page = await client.listUserStorageScopes(
      { root, startAfter: cursor.after, limit: PAGE_SIZE },
      { signal: context.signal },
    );
    if (root === 'playback-sidecars') hashes ??= await userIdsByStorageHash();
    const entries = page.users.map((entry) => ({
      ...entry,
      userId: root === 'playback-sidecars' ? hashes?.get(entry.user) ?? null : entry.user,
    }));
    const existing = await existingUserIds(entries.flatMap((entry) => entry.userId ? [entry.userId] : []));

    for (const entry of entries) {
      totals.scannedUsers += 1;
      if (entry.userId === null) {
        await client.clearUserSidecarsByHash({ storageUserHash: entry.user }, { signal: context.signal });
        totals.clearedSidecarUsers += 1;
        continue;
      }
      if (!existing.has(entry.userId)) {
        await enqueueStorageCleanup({ userId: entry.userId, documentId: null });
        totals.queuedAccounts += 1;
        continue;
      }
      if (entry.documentIds.length === 0) continue;
      const owned = new Set((await db.select({ id: documents.id }).from(documents).where(and(
        eq(documents.userId, entry.userId),
        inArray(documents.id, entry.documentIds),
      )) as Array<{ id: string }>).map((row) => row.id));
      for (const documentId of entry.documentIds) {
        if (owned.has(documentId)) continue;
        await enqueueStorageCleanup({ userId: entry.userId, documentId });
        totals.queuedDocuments += 1;
      }
    }

    if (page.nextStartAfter) {
      cursor.after = page.nextStartAfter;
    } else {
      cursor.root += 1;
      cursor.after = null;
    }
  }

  return {
    summary: `Scan complete: queued ${totals.queuedAccounts} account and ${totals.queuedDocuments} document cleanup(s)`,
    disableTask: true,
    ...totals,
  };
}

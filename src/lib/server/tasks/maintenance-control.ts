import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents } from '@openreader/database/schema';
import * as sqlite from '@openreader/database/schema-auth-sqlite';
import * as postgres from '@openreader/database/schema-auth-postgres';
import { claimUserDeletionBatch, finalizeUserDeletion } from '@/lib/server/admin/users';
import { deleteDocumentPreviewRows } from '@/lib/server/documents/previews';
import { releaseDocumentBlobLease, renewDocumentBlobLease, tryAcquireDocumentBlobLease } from '@/lib/server/documents/blob-lease';
import {
  enqueueStorageCleanup, failStorageCleanup, isStillOwned, listDueStorageCleanups, settleRow,
  type StorageCleanupRow,
} from '@/lib/server/storage/cleanups';

const { user } = process.env.POSTGRES_URL ? postgres : sqlite;

export class InvalidMaintenanceStep extends Error {}

function string(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new InvalidMaintenanceStep('Invalid identifier');
  return value;
}

function strings(value: unknown, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max) throw new InvalidMaintenanceStep('Invalid identifiers');
  return value.map((entry) => string(entry));
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new InvalidMaintenanceStep('Invalid number');
  return value;
}

/** One bounded SQL step; all scanning, iteration and object deletion are worker-owned. */
export async function executeMaintenanceStep(raw: unknown): Promise<unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidMaintenanceStep('Invalid request');
  const body = raw as Record<string, unknown>;
  const after = body.after == null ? null : string(body.after, 600);
  switch (body.action) {
    case 'claim-users':
      return { userIds: await claimUserDeletionBatch({
        after, idleBefore: body.idleBefore == null ? undefined : number(body.idleBefore),
      }) };
    case 'finalize-user':
      await finalizeUserDeletion(string(body.userId));
      return { ok: true };
    case 'cleanup-next': {
      const due = await listDueStorageCleanups(after);
      const rows: StorageCleanupRow[] = [];
      for (const row of due) {
        if (await isStillOwned(row)) await settleRow(row);
        else rows.push(row);
      }
      return { rows, after: due.at(-1)?.id ?? null, done: due.length === 0 };
    }
    case 'cleanup-settle': {
      const rawRow = body.row;
      if (!rawRow || typeof rawRow !== 'object') throw new InvalidMaintenanceStep('Invalid cleanup');
      const entry = rawRow as Record<string, unknown>;
      const row: StorageCleanupRow = {
        id: string(entry.id, 600), userId: string(entry.userId),
        documentId: entry.documentId == null ? null : string(entry.documentId),
        notBeforeMs: number(entry.notBeforeMs), attempts: number(entry.attempts),
      };
      if (body.failed === true) await failStorageCleanup(row);
      else await settleRow(row);
      return { ok: true };
    }
    case 'reap-claim': {
      const id = string(body.documentId);
      if (!/^[a-f0-9]{64}$/i.test(id)) throw new InvalidMaintenanceStep('Invalid document');
      const lease = await tryAcquireDocumentBlobLease(id);
      if (!lease) return { owner: null };
      try {
        const [owned] = await db.select({ id: documents.id }).from(documents).where(eq(documents.id, id)).limit(1);
        if (owned) { await lease.release(); return { owner: null }; }
        await deleteDocumentPreviewRows(id, null);
        return { owner: lease.owner };
      } catch (error) {
        await lease.release();
        throw error;
      }
    }
    case 'reap-release':
      await releaseDocumentBlobLease(string(body.documentId), string(body.owner));
      return { ok: true };
    case 'reap-renew':
      return { renewed: await renewDocumentBlobLease(string(body.documentId), string(body.owner)) };
    case 'list-users': {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (db as any).select({ id: user.id }).from(user)
        .where(after ? sql`${user.id} > ${after}` : undefined).orderBy(asc(user.id)).limit(500) as Array<{ id: string }>;
      return { userIds: rows.map((row) => row.id) };
    }
    case 'scan-user': {
      const userId = string(body.userId);
      const documentIds = strings(body.documentIds, 25);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [exists] = await (db as any).select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
      if (!exists) {
        await enqueueStorageCleanup({ userId, documentId: null });
        return { queued: 1 };
      }
      if (!documentIds.length) return { queued: 0 };
      const owned = new Set((await db.select({ id: documents.id }).from(documents).where(and(
        eq(documents.userId, userId), inArray(documents.id, documentIds),
      )) as Array<{ id: string }>).map((row) => row.id));
      let queued = 0;
      for (const documentId of documentIds) {
        if (owned.has(documentId)) continue;
        await enqueueStorageCleanup({ userId, documentId });
        queued++;
      }
      return { queued };
    }
    default: throw new InvalidMaintenanceStep('Unknown maintenance step');
  }
}

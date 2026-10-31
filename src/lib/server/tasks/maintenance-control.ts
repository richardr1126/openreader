import { eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents } from '@openreader/database/schema';
import { claimUserDeletionBatch, finalizeUserDeletion } from '@/lib/server/admin/users';
import { deleteDocumentPreviewRows } from '@/lib/server/documents/previews';
import { releaseDocumentBlobLease, renewDocumentBlobLease, tryAcquireDocumentBlobLease } from '@/lib/server/documents/blob-lease';
import {
  failStorageCleanup, listDueStorageCleanups, settleIfOwned, settleRow,
  type StorageCleanupRow,
} from '@/lib/server/storage/cleanups';

export class InvalidMaintenanceStep extends Error {}

function string(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value.length || value.length > max) throw new InvalidMaintenanceStep('Invalid identifier');
  return value;
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
        if (!(await settleIfOwned(row))) rows.push(row);
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
    default: throw new InvalidMaintenanceStep('Unknown maintenance step');
  }
}

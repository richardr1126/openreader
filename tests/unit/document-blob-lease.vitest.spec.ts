import { beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as sqliteSchema from '../../src/db/schema_sqlite';

const holder = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof drizzle> }));
vi.mock('@/db', () => ({
  get db() {
    return holder.db;
  },
}));

import { tryAcquireDocumentBlobLease } from '../../src/lib/server/documents/blob-lease';

beforeEach(() => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE document_blob_leases (
    document_id text PRIMARY KEY NOT NULL,
    lease_owner text NOT NULL,
    lease_until_ms integer NOT NULL
  );`);
  holder.db = drizzle(sqlite, { schema: sqliteSchema });
});

describe('document blob lease', () => {
  test('allows only one owner until the lease is released', async () => {
    const first = await tryAcquireDocumentBlobLease('doc-1');
    const blocked = await tryAcquireDocumentBlobLease('doc-1');

    expect(first).not.toBeNull();
    expect(blocked).toBeNull();

    await first?.release();
    await expect(tryAcquireDocumentBlobLease('doc-1')).resolves.not.toBeNull();
  });

  test('allows an expired lease to be reclaimed', async () => {
    const first = await tryAcquireDocumentBlobLease('doc-1');
    expect(first).not.toBeNull();

    await holder.db
      .update(sqliteSchema.documentBlobLeases)
      .set({ leaseUntilMs: Date.now() - 1 });
    const replacement = await tryAcquireDocumentBlobLease('doc-1');

    expect(replacement).not.toBeNull();
    expect(replacement?.owner).not.toBe(first?.owner);

    // Releasing the now-stale original lease must not delete the replacement,
    // since release() is scoped to the original owner.
    await first?.release();

    const rows = await holder.db
      .select()
      .from(sqliteSchema.documentBlobLeases);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.leaseOwner).toBe(replacement?.owner);
  });
});

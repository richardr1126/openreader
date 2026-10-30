import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as auth from '@openreader/database/schema-auth-sqlite';
import { eq } from 'drizzle-orm';

const holder = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof drizzle>, sqlite: null as Database.Database | null }));
vi.mock('@openreader/database', async () => {
  const [{ default: Database }, { drizzle }] = await Promise.all([import('better-sqlite3'), import('drizzle-orm/better-sqlite3')]);
  holder.sqlite = new Database(':memory:');
  holder.db = drizzle(holder.sqlite);
  return { db: holder.db };
});
vi.mock('@openreader/database/run-in-transaction', () => ({
  runInDbTransaction: async (fn: (conn: unknown) => Promise<unknown>) => fn(holder.db),
}));
vi.mock('@/lib/server/user/data-cleanup', () => ({ deleteUserDatabaseData: vi.fn() }));

import { claimUserDeletionBatch } from '@/lib/server/admin/users';

let sqlite: Database.Database;
beforeEach(() => {
  sqlite = holder.sqlite!;
  sqlite.exec(`CREATE TABLE user (
    id text PRIMARY KEY, name text NOT NULL, email text NOT NULL, email_verified integer DEFAULT 0,
    image text, created_at integer NOT NULL, updated_at integer NOT NULL, is_anonymous integer,
    is_admin integer NOT NULL DEFAULT 0, admin_source text DEFAULT 'none', access_status text DEFAULT 'active',
    deletion_requested_at integer
  ); CREATE TABLE session (
    id text PRIMARY KEY, expires_at integer NOT NULL, token text NOT NULL, created_at integer NOT NULL,
    updated_at integer NOT NULL, ip_address text, user_agent text, user_id text NOT NULL
  );`);
});
afterEach(() => sqlite.exec('DROP TABLE session; DROP TABLE user;'));
afterAll(() => sqlite.close());

describe('bounded account deletion claims', () => {
  test('includes stranded deletions and idle guests, while preserving recently active guests and registered accounts', async () => {
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    const old = new Date(cutoff.getTime() - 86_400_000);
    const recent = new Date();
    for (const [id, isAnonymous, updatedAt, pending] of [
      ['a-stranded', true, recent, true], ['b-idle', true, old, false],
      ['c-returned', true, old, false], ['d-active', true, recent, false],
      ['e-registered', false, old, false], ['f-pending-account', false, recent, true],
    ] as const) {
      await holder.db.insert(auth.user).values({ id, name: id, email: `${id}@example.test`, isAnonymous,
        createdAt: old, updatedAt, accessStatus: pending ? 'suspended' : 'active', deletionRequestedAt: pending ? old : null });
    }
    await holder.db.insert(auth.session).values({ id: 'returned-session', token: 'token', userId: 'c-returned',
      createdAt: old, updatedAt: recent, expiresAt: new Date(Date.now() + 86_400_000) });
    const ids = await claimUserDeletionBatch({ idleBefore: cutoff.getTime(), after: null });
    expect(ids).toEqual(['a-stranded', 'b-idle', 'f-pending-account']);
    const [idle] = await holder.db.select().from(auth.user).where(eq(auth.user.id, 'b-idle'));
    expect(idle.deletionRequestedAt).toBeInstanceOf(Date);
    expect(idle.accessStatus).toBe('suspended');
    expect(await holder.db.select().from(auth.session)).toHaveLength(1);
    expect(await claimUserDeletionBatch({ idleBefore: cutoff.getTime(), after: ids.at(-1)! })).toEqual([]);
  });

  test('a recovery run claims existing markers regardless of guest idle policy', async () => {
    await holder.db.insert(auth.user).values({ id: 'pending', name: 'Pending', email: 'pending@example.test',
      createdAt: new Date(), updatedAt: new Date(), isAnonymous: false, deletionRequestedAt: new Date(), accessStatus: 'suspended' });
    expect(await claimUserDeletionBatch({ after: null })).toEqual(['pending']);
  });
});

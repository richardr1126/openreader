import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

vi.mock('@openreader/database', async () => {
  const [{ default: BetterSqlite3 }, { drizzle }] = await Promise.all([
    import('better-sqlite3'),
    import('drizzle-orm/better-sqlite3'),
  ]);
  const sqlite = new BetterSqlite3(':memory:');
  return { db: drizzle(sqlite), testSqlite: sqlite };
});

import * as databaseModule from '@openreader/database';
import { listAdminUsers } from '../../src/lib/server/admin/users';

const sqlite = (databaseModule as unknown as { testSqlite: import('better-sqlite3').Database }).testSqlite;

describe('admin user directory query', () => {
  beforeAll(() => {
    sqlite.exec(`
      CREATE TABLE user (
        id text PRIMARY KEY NOT NULL, name text NOT NULL, email text NOT NULL,
        email_verified integer NOT NULL DEFAULT 0, is_anonymous integer,
        is_admin integer NOT NULL DEFAULT 0, admin_source text NOT NULL DEFAULT 'none',
        access_status text NOT NULL DEFAULT 'active', created_at integer NOT NULL,
        updated_at integer NOT NULL
      );
      CREATE TABLE session (
        id text PRIMARY KEY NOT NULL, user_id text NOT NULL,
        updated_at integer NOT NULL
      );
      CREATE TABLE documents (
        id text NOT NULL, user_id text NOT NULL, size integer NOT NULL
      );
      CREATE TABLE compute_limit_events (
        event_key text PRIMARY KEY NOT NULL, user_id text NOT NULL,
        metric text NOT NULL, units integer NOT NULL
      );
      INSERT INTO user VALUES
        ('owner', 'Owner', 'owner@example.test', 1, 0, 1, 'managed', 'active', 1000, 2000),
        ('pending', 'Reader', 'reader@example.test', 0, 0, 0, 'none', 'pending', 3000, 4000),
        ('guest', 'Guest', 'guest@local', 0, 1, 0, 'none', 'active', 2000, 3000);
      INSERT INTO session VALUES ('s1', 'owner', 5000), ('s2', 'owner', 6000);
      INSERT INTO documents VALUES ('d1', 'owner', 1024), ('d2', 'owner', 512), ('d3', 'guest', 128);
      INSERT INTO compute_limit_events VALUES
        ('e1', 'owner', 'characters', 100), ('e2', 'owner', 'characters', 50),
        ('e3', 'guest', 'input_bytes', 128);
    `);
  });

  afterAll(() => sqlite.close());

  test('paginates and aggregates only the returned users', async () => {
    const result = await listAdminUsers({ page: 2, pageSize: 1 });
    expect(result.total).toBe(3);
    expect(result.counts).toMatchObject({ all: 3, accounts: 2, anonymous: 1, pending: 1, admins: 1 });
    expect(result.users).toHaveLength(1);
    expect(result.users[0]).toMatchObject({ id: 'guest', documentCount: 1, documentBytes: 128, usage: { ttsCharacters: 0, inputBytes: 128, files: 0 } });
  });

  test('filters pending accounts and reports usage and session activity', async () => {
    const pending = await listAdminUsers({ status: 'pending', kind: 'account' });
    expect(pending.users.map((user) => user.id)).toEqual(['pending']);

    const owner = await listAdminUsers({ search: 'owner', kind: 'account' });
    expect(owner.users[0]).toMatchObject({
      id: 'owner', documentCount: 2, documentBytes: 1536, sessionCount: 2,
      lastActiveAt: new Date(6000).toISOString(),
      usage: { ttsCharacters: 150, inputBytes: 0, files: 0 },
    });
  });
});

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPassword } from 'better-auth/crypto';

const directory = mkdtempSync(join(tmpdir(), 'openreader-bootstrap-admin-'));
const databasePath = join(directory, 'bootstrap.db');
let ensureInitialAdmin: typeof import('@/lib/server/auth/bootstrap-admin').ensureInitialAdmin;
const originalEnv = {
  path: process.env.SQLITE_DB_PATH,
  email: process.env.BOOTSTRAP_ADMIN_EMAIL,
  password: process.env.BOOTSTRAP_ADMIN_PASSWORD,
  passwordFile: process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE,
};

beforeAll(async () => {
  process.env.SQLITE_DB_PATH = databasePath;
  process.env.BOOTSTRAP_ADMIN_EMAIL = 'owner@example.test';
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'first-boot-secret-2026';
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE;
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  database.exec(`
    create table user (
      id text primary key, name text not null, email text not null unique,
      email_verified integer not null, image text, is_anonymous integer, is_admin integer not null,
      admin_source text not null, access_status text not null,
      created_at integer not null, updated_at integer not null
    );
    create table account (
      id text primary key, account_id text not null, provider_id text not null,
      issuer text not null, user_id text not null references user(id) on delete cascade,
      access_token text, refresh_token text, id_token text,
      access_token_expires_at integer, refresh_token_expires_at integer,
      scope text, password text, created_at integer not null, updated_at integer not null
    );
    create table admin_settings (
      key text primary key, value_json text not null, source text not null, updated_at integer not null
    );
  `);
  database.close();
  vi.resetModules();
  ({ ensureInitialAdmin } = await import('@/lib/server/auth/bootstrap-admin'));
});

afterAll(() => {
  for (const [name, value] of [
    ['SQLITE_DB_PATH', originalEnv.path],
    ['BOOTSTRAP_ADMIN_EMAIL', originalEnv.email],
    ['BOOTSTRAP_ADMIN_PASSWORD', originalEnv.password],
    ['BOOTSTRAP_ADMIN_PASSWORD_FILE', originalEnv.passwordFile],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe('first administrator bootstrap', () => {
  test('creates one inactive admin credential and consumes the seed', async () => {
    await ensureInitialAdmin();
    const database = new Database(databasePath);
    try {
      const users = database.prepare('select id, email, is_admin, admin_source, access_status, email_verified from user').all() as Array<{
        id: string; email: string; is_admin: number; admin_source: string; access_status: string; email_verified: number;
      }>;
      expect(users).toHaveLength(1);
      expect(users[0]).toMatchObject({
        email: 'owner@example.test', is_admin: 0, admin_source: 'bootstrap', access_status: 'active', email_verified: 0,
      });
      const account = database.prepare('select account_id, provider_id, issuer, password from account').get() as {
        account_id: string; provider_id: string; issuer: string; password: string;
      };
      expect(account.account_id).toBe(users[0].id);
      expect(account).toMatchObject({ provider_id: 'credential', issuer: 'local:credential' });
      expect(await verifyPassword({ hash: account.password, password: 'first-boot-secret-2026' })).toBe(true);
      expect(database.prepare('select count(*) as value from admin_settings where key = ?').get('initialAdminBootstrapped'))
        .toEqual({ value: 1 });
    } finally { database.close(); }
  });

  test('does not recreate the account after deletion or a changed seed', async () => {
    const database = new Database(databasePath);
    database.exec('delete from user');
    database.close();
    process.env.BOOTSTRAP_ADMIN_EMAIL = 'replacement@example.test';
    process.env.BOOTSTRAP_ADMIN_PASSWORD = 'replacement-secret-2026';
    vi.resetModules();
    ({ ensureInitialAdmin } = await import('@/lib/server/auth/bootstrap-admin'));
    await ensureInitialAdmin();
    const next = new Database(databasePath);
    try {
      expect(next.prepare('select count(*) as value from user').get()).toEqual({ value: 0 });
    } finally { next.close(); }
  });
});

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { hashPassword } from 'better-auth/crypto';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { runMigrations } from '@openreader/database/migrate';

// Better Auth 1.7.0-1.7.2 required account.issuer; 1.7.3 dropped it again.
// Accounts written while the column existed must keep signing in after 0022.
const directory = mkdtempSync(join(tmpdir(), 'openreader-issuer-removal-'));
const databasePath = join(directory, 'auth.db');
const originalEnv = {
  path: process.env.SQLITE_DB_PATH,
  postgres: process.env.POSTGRES_URL,
  rateLimit: process.env.DISABLE_AUTH_RATE_LIMIT,
  baseUrl: process.env.BASE_URL,
};
let auth: Awaited<ReturnType<typeof import('@/lib/server/auth/auth')['getAuth']>>;

function migrateThrough(tag: string): void {
  const source = join(process.cwd(), 'packages/database/migrations/sqlite');
  const folder = join(directory, 'migrations');
  cpSync(source, folder, { recursive: true });
  const journalPath = join(folder, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const end = journal.entries.findIndex((entry) => entry.tag === tag);
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, end + 1) }));
  const sqlite = new Database(databasePath);
  try { migrate(drizzle(sqlite), { migrationsFolder: folder }); } finally { sqlite.close(); }
}

function post(path: string, body: unknown): Promise<Response> {
  return auth.handler(new Request(`http://localhost:3003/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3003' },
    body: JSON.stringify(body),
  }));
}

beforeAll(async () => {
  migrateThrough('0021_ios_parity');
  const now = Date.now();
  const sqlite = new Database(databasePath);
  try {
    sqlite.prepare(`insert into user (id, name, email, email_verified, is_anonymous, is_admin, admin_source, access_status, created_at, updated_at)
      values ('existing-user', 'Existing', 'existing@example.test', 1, 0, 0, 'none', 'active', ?, ?)`).run(now, now);
    sqlite.prepare(`insert into account (id, account_id, provider_id, issuer, user_id, password, created_at, updated_at)
      values ('existing-account', 'existing-user', 'credential', 'local:credential', 'existing-user', ?, ?, ?)`)
      .run(await hashPassword('existing-password-1'), now, now);
  } finally { sqlite.close(); }

  process.env.SQLITE_DB_PATH = databasePath;
  delete process.env.POSTGRES_URL;
  process.env.DISABLE_AUTH_RATE_LIMIT = 'true';
  // Vite exposes its own BASE_URL ('/') to test workers.
  process.env.BASE_URL = 'http://localhost:3003';
  await runMigrations({ cwd: directory, env: { ...process.env, SQLITE_DB_PATH: databasePath, POSTGRES_URL: '' } });
  vi.resetModules();
  auth = await (await import('@/lib/server/auth/auth')).getAuth();
});

afterAll(() => {
  for (const [name, value] of [
    ['SQLITE_DB_PATH', originalEnv.path],
    ['POSTGRES_URL', originalEnv.postgres],
    ['DISABLE_AUTH_RATE_LIMIT', originalEnv.rateLimit],
    ['BASE_URL', originalEnv.baseUrl],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe('account issuer removal', () => {
  test('drops the column and its index without losing accounts', () => {
    const sqlite = new Database(databasePath, { readonly: true });
    try {
      const columns = sqlite.prepare('PRAGMA table_info(account)').all().map((column) => (column as { name: string }).name);
      expect(columns).not.toContain('issuer');
      expect(sqlite.prepare("select name from sqlite_master where name = 'account_issuer_accountId_uidx'").all()).toEqual([]);
      expect(sqlite.prepare('select id, account_id, provider_id from account').all()).toEqual([
        { id: 'existing-account', account_id: 'existing-user', provider_id: 'credential' },
      ]);
    } finally { sqlite.close(); }
  });

  test('a credential written before the drop still signs in', async () => {
    expect((await post('/sign-in/email', { email: 'existing@example.test', password: 'existing-password-1' })).status).toBe(200);
    expect((await post('/sign-in/email', { email: 'existing@example.test', password: 'wrong-password-1' })).status).toBe(401);
  });

  test('new credential accounts insert without an issuer', async () => {
    const response = await post('/sign-up/email', { email: 'new@example.test', password: 'new-password-1', name: 'New' });
    expect(response.status).toBe(200);
    expect((await post('/sign-in/email', { email: 'new@example.test', password: 'new-password-1' })).status).toBe(200);
  });
});

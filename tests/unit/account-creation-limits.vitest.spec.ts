import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeAll, afterAll, expect, test, vi } from 'vitest';
import { runMigrations } from '@openreader/database/migrate';
import { hashIp, normalizeIp } from '@/lib/server/auth/ip-privacy';

const directory = mkdtempSync(join(tmpdir(), 'openreader-creation-'));
const databasePath = join(directory, 'sqlite.db');
const original = { ...process.env };
const origin = 'http://localhost:3003';
let auth: Awaited<ReturnType<typeof import('@/lib/server/auth/auth').getAuth>>;
let settings: typeof import('@/lib/server/admin/settings');
function sql(query: string) {
  const database = new Database(databasePath);
  try { return database.prepare(query).all() as Record<string, unknown>[]; } finally { database.close(); }
}
async function call(path: string, body: unknown, ip?: string) {
  return auth.handler(new Request(`${origin}/api/auth${path}`, { method: 'POST', headers: {
    Origin: origin, 'Content-Type': 'application/json', ...(ip ? { 'x-real-ip': ip, 'x-forwarded-for': ip } : {}),
  }, body: JSON.stringify(body) }));
}
beforeAll(async () => {
  process.env.SQLITE_DB_PATH = databasePath; delete process.env.POSTGRES_URL; delete process.env.DESKTOP_LAUNCH_TOKEN;
  process.env.BASE_URL = origin; process.env.DISABLE_AUTH_RATE_LIMIT = 'false';
  process.env.AUTH_SECRET = 'creation-disposable-secret-at-least-32-characters';
  await runMigrations({ cwd: directory, env: { ...process.env, POSTGRES_URL: '', SQLITE_DB_PATH: databasePath } });
  vi.resetModules();
  settings = await import('@/lib/server/admin/settings');
  await settings.setRuntimeConfigKey('allowAnonymousSessions', true);
  auth = await (await import('@/lib/server/auth/auth')).getAuth();
});
afterAll(() => {
  for (const key of ['SQLITE_DB_PATH', 'POSTGRES_URL', 'DESKTOP_LAUNCH_TOKEN', 'BASE_URL', 'DISABLE_AUTH_RATE_LIMIT', 'AUTH_SECRET']) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  rmSync(directory, { recursive: true, force: true });
});
test('normalizes IPv6 /64s, mapped IPv4, and separates session and creation hashes', () => {
  expect(normalizeIp('2001:0db8:abcd:1234::1')).toBe(normalizeIp('2001:db8:abcd:1234:ffff::2'));
  expect(normalizeIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
  expect(hashIp('192.0.2.1', 'session')).not.toBe(hashIp('192.0.2.1', 'guest-creation'));
  expect(hashIp('invalid', 'session')).toBeNull();
});
test('migration clears old raw session IPs and drops retired admission keys without deleting sessions', () => {
  const database = new Database(':memory:');
  try {
    database.exec(`create table session(id text primary key, ip_address text);
      insert into session values ('kept', '192.0.2.1');
      create table compute_limit_admissions(id text, device_scope_key text, ip_scope_key text);
      insert into compute_limit_admissions values ('kept', 'device', 'ip');
      create table compute_limit_buckets(scope_type text);
      insert into compute_limit_buckets values ('user'), ('ip'), ('anonymous_device');`);
    const migration = readFileSync(new URL('../../packages/database/migrations/sqlite/0027_public_api.sql', import.meta.url), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').map((part) => part.trim())) {
      if (/^(UPDATE session|DELETE FROM compute_limit_buckets|ALTER TABLE `compute_limit_admissions` DROP)/.test(statement)) database.exec(statement);
    }
    expect(database.prepare('select * from session').all()).toEqual([{ id: 'kept', ip_address: null }]);
    expect(database.prepare('select * from compute_limit_admissions').all()).toEqual([{ id: 'kept' }]);
    expect(database.prepare('select * from compute_limit_buckets').all()).toEqual([{ scope_type: 'user' }]);
  } finally { database.close(); }
});
test('enforces guest and full-account caps at the real user hook without capping unknown IPs', async () => {
  await settings.setRuntimeConfigKey('limitNewGuestsPerIp', true);
  await settings.setRuntimeConfigKey('newGuestsPerIp', 1);
  await settings.setRuntimeConfigKey('limitNewAccountsPerIp', true);
  await settings.setRuntimeConfigKey('newAccountsPerIp', 1);
  const first = await call('/sign-in/anonymous', {}, '2001:db8:abcd:1234::1');
  expect(first.status).toBe(200);
  const blocked = await call('/sign-in/anonymous', {}, '2001:db8:abcd:1234::2');
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toMatchObject({ code: 'ACCOUNT_CREATION_LIMITED' });
  const signup = (email: string) => call('/sign-up/email', { name: 'Reader', email, password: 'AccountTest#2026' }, '2001:db8:abcd:1234::3');
  expect((await signup('first@example.test')).status).toBe(200);
  expect((await signup('second@example.test')).status).toBe(429);
  expect((await call('/sign-in/anonymous', {})).status).toBe(200);
  const sessions = sql('select ip_address from session where ip_address is not null');
  expect(sessions.length).toBeGreaterThan(0);
  for (const session of sessions) expect(session.ip_address).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(sql('select scope_key from compute_limit_buckets'))).not.toContain('2001:');
  expect((await call('/sign-in/email', { email: 'first@example.test', password: 'AccountTest#2026' }, '2001:db8:abcd:1234::4')).status).toBe(200);
});
test('rolling counters expire exactly at the period boundary and serialize concurrent creation', async () => {
  const { enforceCreationLimit } = await import('@/lib/server/auth/creation-limits');
  const config = await settings.getRuntimeConfig();
  const now = Date.UTC(2026, 10, 1);
  const check = (nowMs: number) => enforceCreationLimit({ config, ip: '192.0.2.20', isAnonymous: false, nowMs });
  const results = await Promise.allSettled([check(now), check(now), check(now)]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  await expect(check(now + config.newAccountsPerIpDays * 86_400_000 - 1)).rejects.toThrow();
  await expect(check(now + config.newAccountsPerIpDays * 86_400_000)).resolves.toBeUndefined();
});
test('Better Auth still throttles incoming IPs after session hashing', async () => {
  const responses = [];
  for (let index = 0; index < 12; index++) responses.push(await call('/sign-in/email', { email: 'missing@example.test', password: 'AccountTest#2026' }, '192.0.2.99'));
  expect(responses.some((response) => response.status === 429)).toBe(true);
  expect(responses.find((response) => response.status === 429)?.headers.get('x-retry-after')).toBeTruthy();
  expect((await call('/sign-in/email', { email: 'missing@example.test', password: 'AccountTest#2026' }, '192.0.2.100')).status).toBe(401);
});

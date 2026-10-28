import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { runMigrations } from '@openreader/database/migrate';

const LAUNCH_TOKEN = 'desktop-launch-token-for-vitest-0123456789abcdef';
const OWNER_EMAIL = 'owner@openreader.localhost';
const directory = mkdtempSync(join(tmpdir(), 'openreader-desktop-owner-'));
const databasePath = join(directory, 'desktop.db');
const originalEnv = {
  path: process.env.SQLITE_DB_PATH,
  token: process.env.DESKTOP_LAUNCH_TOKEN,
  postgres: process.env.POSTGRES_URL,
  rateLimit: process.env.DISABLE_AUTH_RATE_LIMIT,
  baseUrl: process.env.BASE_URL,
};

type AuthModule = typeof import('@/lib/server/auth/auth');
let authModule: AuthModule;

function exchangeRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3003/api/auth/desktop/session', { method: 'POST', headers });
}

async function exchange(headers: Record<string, string> = { authorization: `Bearer ${LAUNCH_TOKEN}` }): Promise<Response> {
  return (await authModule.getAuth()).handler(exchangeRequest(headers));
}

function sessionCookie(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const match = /better-auth\.session_token=[^;]+/.exec(header);
  if (!match) throw new Error('exchange did not set a session cookie');
  return match[0];
}

function query<T>(sql: string, ...params: unknown[]): T[] {
  const database = new Database(databasePath, { readonly: true });
  try { return database.prepare(sql).all(...params) as T[]; } finally { database.close(); }
}

function realUsers() {
  return query<{ id: string; email: string; is_admin: number; admin_source: string; access_status: string }>(
    "select id, email, is_admin, admin_source, access_status from user where id != 'unclaimed' order by created_at",
  );
}

async function loadAuth(token: string | undefined): Promise<void> {
  if (token === undefined) delete process.env.DESKTOP_LAUNCH_TOKEN;
  else process.env.DESKTOP_LAUNCH_TOKEN = token;
  vi.resetModules();
  authModule = await import('@/lib/server/auth/auth');
}

beforeAll(async () => {
  process.env.SQLITE_DB_PATH = databasePath;
  delete process.env.POSTGRES_URL;
  process.env.DISABLE_AUTH_RATE_LIMIT = 'true';
  // Vite exposes its own BASE_URL ('/') to test workers.
  process.env.BASE_URL = 'http://localhost:3003';
  await runMigrations({ cwd: directory, env: { ...process.env, SQLITE_DB_PATH: databasePath, POSTGRES_URL: '' } });
});

afterAll(() => {
  for (const [name, value] of [
    ['SQLITE_DB_PATH', originalEnv.path],
    ['DESKTOP_LAUNCH_TOKEN', originalEnv.token],
    ['POSTGRES_URL', originalEnv.postgres],
    ['DISABLE_AUTH_RATE_LIMIT', originalEnv.rateLimit],
    ['BASE_URL', originalEnv.baseUrl],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe('desktop owner session exchange', () => {
  test('does not exist without a launch token', async () => {
    await loadAuth(undefined);
    const response = await exchange();
    expect(response.status).toBe(404);
    expect(realUsers()).toHaveLength(0);
    const { getResolvedRuntimeConfig } = await import('@/lib/server/runtime-config');
    expect((await getResolvedRuntimeConfig()).installProfile).toBe('server');
  });

  test('rejects missing, wrong and browser-originated tokens without detail', async () => {
    await loadAuth(LAUNCH_TOKEN);
    const attempts: Array<Record<string, string>> = [
      {},
      { authorization: 'Bearer wrong-token' },
      { authorization: `Bearer ${LAUNCH_TOKEN}x` },
      { authorization: LAUNCH_TOKEN },
      { authorization: `Bearer ${LAUNCH_TOKEN}`, origin: 'http://localhost:3003' },
      { authorization: `Bearer ${LAUNCH_TOKEN}`, 'sec-fetch-site': 'same-origin' },
    ];
    for (const headers of attempts) {
      const response = await exchange(headers);
      expect(response.status, JSON.stringify(Object.keys(headers))).toBe(401);
      expect(response.headers.get('set-cookie')).toBeNull();
      const body = await response.text();
      expect(body).not.toContain(LAUNCH_TOKEN);
      expect(body).not.toMatch(/token|origin|mismatch/i);
    }
    expect(realUsers()).toHaveLength(0);
  });

  test('first exchange creates one admin owner without a credential and seeds desktop settings', async () => {
    await loadAuth(LAUNCH_TOKEN);
    const response = await exchange();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toEqual({ ok: true });
    sessionCookie(response);

    const users = realUsers();
    expect(users).toEqual([expect.objectContaining({
      email: OWNER_EMAIL, is_admin: 1, admin_source: 'managed', access_status: 'active',
    })]);
    const ownerId = users[0].id;
    expect(query('select id from account where user_id = ?', ownerId)).toEqual([]);

    const settings = Object.fromEntries(query<{ key: string; value_json: string }>(
      'select key, value_json from admin_settings',
    ).map((row) => [row.key, JSON.parse(row.value_json)]));
    expect(settings.signupPolicy).toBe('closed');
    expect(settings.allowAnonymousSessions).toBe(false);
    expect(settings.initialAdminBootstrapped).toEqual({ version: 1, userId: ownerId });
    expect(settings.desktopOwner).toEqual({ version: 1, userId: ownerId });

    const { getResolvedRuntimeConfig } = await import('@/lib/server/runtime-config');
    const runtimeConfig = await getResolvedRuntimeConfig();
    expect(runtimeConfig.installProfile).toBe('desktop');
    expect(runtimeConfig.signupPolicy).toBe('closed');
    expect(runtimeConfig.allowAnonymousSessions).toBe(false);
  });

  test('repeated exchanges create sessions for the same owner and no new users', async () => {
    await loadAuth(LAUNCH_TOKEN);
    const [ownerBefore] = realUsers();
    const first = sessionCookie(await exchange());
    const second = sessionCookie(await exchange());
    expect(first).not.toBe(second);
    expect(realUsers()).toEqual([ownerBefore]);
    expect(query('select user_id from session where user_id != ?', ownerBefore.id)).toEqual([]);
  });

  test('the exchanged cookie authenticates ordinary and admin routes as the owner', async () => {
    await loadAuth(LAUNCH_TOKEN);
    const cookie = sessionCookie(await exchange());
    const [owner] = realUsers();
    const headers = new Headers({ cookie });
    const context = await authModule.getAuthContext({ headers } as never);
    expect(context.userId).toBe(owner.id);
    const { requireAdminContext } = await import('@/lib/server/auth/admin');
    const admin = await requireAdminContext({ headers } as never);
    expect(admin).not.toBeInstanceOf(Response);

    // Sign-up is closed by the first exchange, so no second account can appear.
    const signUp = await (await authModule.getAuth()).handler(new Request('http://localhost:3003/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'intruder@example.test', password: 'intruder-password-1', name: 'Intruder' }),
    }));
    expect(signUp.ok).toBe(false);
    expect(realUsers()).toHaveLength(1);
  });

  test('never adopts another account that holds the owner address', async () => {
    await loadAuth(LAUNCH_TOKEN);
    const database = new Database(databasePath);
    try {
      database.exec("delete from user where id != 'unclaimed'");
      database.prepare(`insert into user (id, name, email, email_verified, is_anonymous, is_admin, admin_source, access_status, created_at, updated_at)
        values ('someone-else', 'Someone', ?, 0, 0, 0, 'none', 'active', ?, ?)`).run(OWNER_EMAIL, Date.now(), Date.now());
    } finally { database.close(); }

    const response = await exchange();
    expect(response.status).toBe(500);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(query('select count(*) as value from session where user_id = ?', 'someone-else')).toEqual([{ value: 0 }]);
    expect(realUsers()).toEqual([expect.objectContaining({ id: 'someone-else', is_admin: 0 })]);
  });

  test('recreates a deleted owner as a new account', async () => {
    await loadAuth(LAUNCH_TOKEN);
    const database = new Database(databasePath);
    try { database.exec("delete from user where id != 'unclaimed'"); } finally { database.close(); }
    const response = await exchange();
    expect(response.status).toBe(200);
    expect(realUsers()).toEqual([expect.objectContaining({ email: OWNER_EMAIL, is_admin: 1 })]);
  });
});

describe('account email delivery', () => {
  test('refuses reserved localhost recipients before queueing', async () => {
    const { enqueueAccountEmail, isUndeliverableRecipient } = await import('@/lib/server/email/delivery');
    expect(isUndeliverableRecipient(OWNER_EMAIL)).toBe(true);
    expect(isUndeliverableRecipient('reader@example.com')).toBe(false);
    await expect(enqueueAccountEmail({ purpose: 'admin_test', recipient: OWNER_EMAIL, allowWhenDisabled: true }))
      .rejects.toThrow('ACCOUNT_EMAIL_RECIPIENT_UNDELIVERABLE');
  });
});

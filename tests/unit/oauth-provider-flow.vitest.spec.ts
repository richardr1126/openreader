import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { beforeAll, afterAll, expect, test, vi } from 'vitest';
import { runMigrations } from '@openreader/database/migrate';
import type { JwtOptions } from 'better-auth/plugins';

const directory = mkdtempSync(join(tmpdir(), 'openreader-oauth-'));
const databasePath = join(directory, 'sqlite.db');
const origin = 'http://localhost:3003', resource = `${origin}/api/v1`;
const redirect = 'http://127.0.0.1:43210/callback';
const original = { ...process.env };
let auth: Awaited<ReturnType<typeof import('@/lib/server/auth/auth').getAuth>>;
let cookie: string, userId: string, clientId: string;
let first: { access_token: string; refresh_token: string };

function sql<T = Record<string, unknown>>(query: string, ...args: unknown[]): T[] {
  const database = new Database(databasePath);
  try { return database.prepare(query).all(...args) as T[]; } finally { database.close(); }
}
async function call(path: string, body?: unknown, session?: string, form = false) {
  return auth.handler(new Request(`${origin}/api/auth${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
    Origin: origin, ...(session ? { cookie: session } : {}),
    ...(body === undefined ? { Accept: 'text/html' } : { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }),
  }, ...(body === undefined ? {} : { body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body) }) }));
}
async function authorize(scopes = 'documents:read offline_access') {
  const verifier = randomBytes(32).toString('hex');
  const params = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirect,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: scopes, resource, state: 'test-state', prompt: 'consent' });
  const response = await call(`/oauth2/authorize?${params}`, undefined, cookie);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!, origin);
  expect(location.pathname).toBe('/oauth/consent');
  return { verifier, query: location.searchParams.toString() };
}
async function grant(scopes = 'documents:read offline_access') {
  const intent = await authorize(scopes);
  const consent = await call('/oauth2/consent', { accept: true, scope: scopes, oauth_query: intent.query }, cookie);
  const result = consent.headers.get('location') ? { url: consent.headers.get('location')! } : await consent.json();
  expect(typeof result.url).toBe('string');
  const callback = new URL(result.url);
  expect(callback.origin + callback.pathname).toBe(redirect);
  const token = await call('/oauth2/token', { grant_type: 'authorization_code', client_id: clientId,
    code: callback.searchParams.get('code')!, redirect_uri: redirect, code_verifier: intent.verifier, resource }, undefined, true);
  expect(token.status).toBe(200);
  return await token.json() as { access_token: string; refresh_token: string };
}
async function principal(token: string, scope: 'documents:read' | 'documents:write' = 'documents:read') {
  const { resolveApiPrincipal } = await import('@/lib/server/api/principal');
  return resolveApiPrincipal(new NextRequest(`${resource}/me`, { headers: { authorization: `Bearer ${token}` } }), scope);
}
beforeAll(async () => {
  process.env.SQLITE_DB_PATH = databasePath; delete process.env.POSTGRES_URL; delete process.env.DESKTOP_LAUNCH_TOKEN;
  process.env.BASE_URL = origin; process.env.DISABLE_AUTH_RATE_LIMIT = 'true';
  process.env.AUTH_SECRET = 'oauth-disposable-test-secret-at-least-32-characters';
  await runMigrations({ cwd: directory, env: { ...process.env, POSTGRES_URL: '', SQLITE_DB_PATH: databasePath } });
  vi.resetModules(); auth = await (await import('@/lib/server/auth/auth')).getAuth();
  const signup = await call('/sign-up/email', { name: 'OAuth reader', email: 'oauth-reader@example.test', password: 'OAuthFixture#2026' });
  expect(signup.status).toBe(200);
  cookie = /better-auth\.session_token=[^;]+/.exec(signup.headers.get('set-cookie')!)![0];
  userId = sql<{ id: string }>('select id from user where email=?', 'oauth-reader@example.test')[0].id;
  const registered = await call('/oauth2/register', { client_name: 'OAuth flow fixture', redirect_uris: [redirect], application_type: 'native',
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
    scope: 'documents:read documents:write audio:generate offline_access', resources: [resource] });
  expect(registered.status).toBe(201);
  clientId = (await registered.json()).client_id;
});
afterAll(() => {
  for (const key of ['SQLITE_DB_PATH', 'POSTGRES_URL', 'DESKTOP_LAUNCH_TOKEN', 'BASE_URL', 'DISABLE_AUTH_RATE_LIMIT', 'AUTH_SECRET']) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
  rmSync(directory, { recursive: true, force: true });
});

test('authorization code, PKCE, consent and JWT give only the granted API scopes', async () => {
  first = await grant();
  expect(first.access_token.split('.')).toHaveLength(3);
  const identity = await principal(first.access_token);
  expect(identity).toMatchObject({ userId, isAnonymous: false, clientId, scopes: ['documents:read'] });
  const forbidden = await principal(first.access_token, 'documents:write');
  expect(forbidden).toBeInstanceOf(Response); expect((forbidden as Response).status).toBe(403);
  const { GET } = await import('@/app/api/v1/me/route');
  const me = await GET(new NextRequest(`${resource}/me`, { headers: { authorization: `Bearer ${first.access_token}` } }));
  expect(me.status).toBe(200); expect(await me.json()).toMatchObject({ id: userId, scopes: ['documents:read'] });
  const consent = sql<{ id: string }>('select id from oauth_consent where user_id=? and client_id=?', userId, clientId)[0];
  expect(sql<{ reference_id: string }>('select reference_id from oauth_refresh_token where user_id=?', userId)[0].reference_id).toBe(consent.id);
  const { listConnectedApps } = await import('@/lib/server/auth/connected-apps');
  expect((await listConnectedApps(userId)).data).toEqual([expect.objectContaining({
    id: clientId, name: 'OAuth flow fixture', scopes: ['documents:read', 'offline_access'], redirectDomains: ['127.0.0.1:43210'],
  })]);
  expect(JSON.parse(sql<{ scopes: string }>('select scopes from oauth_consent where id=?', consent.id)[0].scopes)).toEqual(['documents:read', 'offline_access']);
});

test('refresh rotates, preserves grant binding and rejects reuse', async () => {
  const refreshed = await call('/oauth2/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token, resource }, undefined, true);
  expect(refreshed.status).toBe(200);
  const next = await refreshed.json();
  expect(next.refresh_token).not.toBe(first.refresh_token);
  expect(await principal(next.access_token)).toMatchObject({ userId });
  const reused = await call('/oauth2/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token, resource }, undefined, true);
  expect(reused.status).toBe(400);
});

test('disconnect immediately cuts off JWTs and refresh tokens, including after reconnect', async () => {
  const token = await grant();
  const oldRow = sql('select * from oauth_refresh_token where user_id=? order by created_at desc limit 1', userId)[0];
  const { disconnectApp } = await import('@/lib/server/auth/connected-apps');
  await disconnectApp(userId, clientId);
  expect((await principal(token.access_token) as Response).status).toBe(401);
  expect(sql('select id from oauth_refresh_token where user_id=?', userId)).toHaveLength(0);
  const reconnected = await grant();
  expect(await principal(reconnected.access_token)).toMatchObject({ userId });
  expect((await principal(token.access_token) as Response).status).toBe(401);
  // An issuance racing disconnect must not regain authorization after reconnect.
  const database = new Database(databasePath);
  const columns = Object.keys(oldRow);
  database.prepare(`insert into oauth_refresh_token (${columns.join(',')}) values (${columns.map(() => '?').join(',')})`).run(...columns.map(column => oldRow[column]));
  database.close();
  const stale = await call('/oauth2/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token.refresh_token, resource }, undefined, true);
  expect(stale.status).not.toBe(200);
});

test('wrong resource, redirect URI, missing PKCE and forged consent requests fail closed', async () => {
  const params = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: redirect, scope: 'documents:read', resource: `${origin}/api/mcp` });
  const wrong = await call(`/oauth2/authorize?${params}`, undefined, cookie);
  expect(wrong.status).not.toBe(200);
  params.set('resource', resource); params.set('redirect_uri', 'https://foreign.test/callback');
  const foreign = await call(`/oauth2/authorize?${params}`, undefined, cookie);
  expect(foreign.headers.get('location') || '').not.toContain('foreign.test');
  params.set('redirect_uri', redirect);
  const noProof = await call(`/oauth2/authorize?${params}`, undefined, cookie);
  expect(new URL(noProof.headers.get('location')!, origin).searchParams.get('error')).toBeTruthy();
  const intent = await authorize();
  const altered = new URLSearchParams(intent.query); altered.set('scope', 'documents:write');
  const tampered = await call('/oauth2/consent', { accept: true, oauth_query: altered.toString() }, cookie);
  expect(tampered.status).toBe(400);
});

test('device authorization issues scoped OAuth tokens and cannot issue a browser session', async () => {
  const { disconnectApp } = await import('@/lib/server/auth/connected-apps');
  await disconnectApp(userId, clientId);
  const requested = await call('/device/code', { client_id: clientId, scope: 'documents:read offline_access', resource }, undefined, true);
  expect(requested.status).toBe(200);
  const code = await requested.json();
  const checked = await call(`/device?user_code=${encodeURIComponent(code.user_code)}`, undefined, cookie);
  expect(checked.status).toBe(200);
  expect(await checked.json()).toMatchObject({ client_id: clientId, resource });
  expect((await call('/device/approve', { userCode: code.user_code }, cookie)).status).toBe(200);
  const sessionAttempt = await call('/device/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: code.device_code }, undefined, true);
  expect(sessionAttempt.status).toBe(404);
  const exchanged = await call('/oauth2/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: code.device_code, resource }, undefined, true);
  expect(exchanged.status).toBe(200);
  const token = await exchanged.json();
  expect(await principal(token.access_token)).toMatchObject({ userId, scopes: ['documents:read'] });
});

test('bearer checks reject wrong audiences, issuers, expiry, signatures and cookie fallback', async () => {
  const token = await grant();
  const payload = JSON.parse(Buffer.from(token.access_token.split('.')[1], 'base64url').toString('utf8'));
  const { signJWT } = await import('better-auth/plugins');
  const plugin = auth.options.plugins!.find(plugin => plugin.id === 'jwt')!;
  const options = 'options' in plugin ? plugin.options as JwtOptions : undefined;
  for (const change of [{ aud: `${origin}/api/mcp` }, { iss: 'https://foreign.test/api/auth' }, { exp: Math.floor(Date.now() / 1000) - 60 }]) {
    const wrong = await signJWT({ context: await auth.$context } as never, { options, header: { typ: 'at+jwt' }, payload: { ...payload, ...change } });
    expect((await principal(wrong) as Response).status).toBe(401);
  }
  const parts = token.access_token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...payload, scope: 'documents:write' })).toString('base64url');
  expect((await principal(parts.join('.')) as Response).status).toBe(401);
  const { resolveApiPrincipal } = await import('@/lib/server/api/principal');
  const fallback = await resolveApiPrincipal(new NextRequest(`${resource}/me`, { headers: { cookie, authorization: 'Bearer invalid' } }), 'documents:read');
  expect((fallback as Response).status).toBe(401);
  const { GET } = await import('@/app/api/user/connected-apps/route');
  expect((await GET(new NextRequest(`${origin}/api/user/connected-apps`, { headers: { cookie, authorization: `Bearer ${token.access_token}` } }))).status).toBe(403);
});

test('suspension, guest conversion and client disabling immediately invalidate access', async () => {
  const token = await grant();
  const database = new Database(databasePath);
  for (const [change, restore] of [
    ["update user set access_status='suspended' where id=?", "update user set access_status='active' where id=?"],
    ['update user set is_anonymous=1 where id=?', 'update user set is_anonymous=0 where id=?'],
  ]) {
    database.prepare(change).run(userId);
    expect((await principal(token.access_token) as Response).status).toBe(401);
    database.prepare(restore).run(userId);
  }
  database.prepare('update oauth_client set disabled=1 where client_id=?').run(clientId);
  expect((await principal(token.access_token) as Response).status).toBe(401);
  database.prepare('update oauth_client set disabled=0 where client_id=?').run(clientId);
  database.close();
});

test('the registration switch takes effect and guests cannot consent or approve devices', async () => {
  const settings = await import('@/lib/server/admin/settings');
  await settings.setRuntimeConfigKey('allowOAuthClientRegistration', false);
  auth = await (await import('@/lib/server/auth/auth')).getAuth();
  expect((await call('/oauth2/register', { client_name: 'Disabled registration', redirect_uris: [redirect], token_endpoint_auth_method: 'none' })).status).toBe(403);
  await settings.setRuntimeConfigKey('allowOAuthClientRegistration', true);
  await settings.setRuntimeConfigKey('allowAnonymousSessions', true);
  auth = await (await import('@/lib/server/auth/auth')).getAuth();
  const guest = await call('/sign-in/anonymous', {});
  expect(guest.status).toBe(200);
  const guestCookie = /better-auth\.session_token=[^;]+/.exec(guest.headers.get('set-cookie')!)![0];
  const intent = await authorize();
  expect((await call('/oauth2/consent', { accept: true, oauth_query: intent.query }, guestCookie)).status).toBe(403);
  expect((await call('/device/approve', { userCode: 'unexpected-code' }, guestCookie)).status).toBe(403);
});

test('disconnect invalidates an approved device code before it is exchanged', async () => {
  const requested = await call('/device/code', { client_id: clientId, scope: 'documents:read offline_access', resource }, undefined, true);
  const code = await requested.json();
  await call(`/device?user_code=${encodeURIComponent(code.user_code)}`, undefined, cookie);
  expect((await call('/device/approve', { userCode: code.user_code }, cookie)).status).toBe(200);
  const { disconnectApp } = await import('@/lib/server/auth/connected-apps');
  await disconnectApp(userId, clientId);
  expect((await call('/oauth2/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: code.device_code, resource }, undefined, true)).status).toBe(400);
  expect((await call('/device/code', { client_id: 'not-a-registered-client', scope: 'documents:read', resource }, undefined, true)).status).toBe(400);
});

test('connected apps and disconnect are isolated to the approving user', async () => {
  const token = await grant();
  const signup = await call('/sign-up/email', { name: 'Other reader', email: 'other-reader@example.test', password: 'OAuthFixture#2026' });
  expect(signup.status).toBe(200);
  const other = sql<{ id: string }>('select id from user where email=?', 'other-reader@example.test')[0].id;
  const { disconnectApp, listConnectedApps } = await import('@/lib/server/auth/connected-apps');
  expect((await listConnectedApps(other)).data).toHaveLength(0);
  await disconnectApp(other, clientId);
  expect(await principal(token.access_token)).toMatchObject({ userId });
  expect((await listConnectedApps(userId)).data).toHaveLength(1);
});

test.each([false, true])('a device exchange racing disconnect cannot recreate authorization (reconnect=%s)', async reconnect => {
  const requested = await call('/device/code', { client_id: clientId, scope: 'documents:read offline_access', resource }, undefined, true);
  const code = await requested.json();
  await call(`/device?user_code=${encodeURIComponent(code.user_code)}`, undefined, cookie);
  expect((await call('/device/approve', { userCode: code.user_code }, cookie)).status).toBe(200);
  const context = await auth.$context;
  const consume = context.adapter.consumeOne.bind(context.adapter);
  const { disconnectApp } = await import('@/lib/server/auth/connected-apps');
  const spy = vi.spyOn(context.adapter, 'consumeOne').mockImplementationOnce(async options => {
    expect(options.model).toBe('deviceCode');
    const claimed = await consume(options);
    // Pause after the provider consumes the code, before it signs a token.
    await disconnectApp(userId, clientId);
    if (reconnect) await grant();
    return claimed;
  });
  try {
    const response = await call('/oauth2/token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId, device_code: code.device_code, resource }, undefined, true);
    expect(spy).toHaveBeenCalled();
    expect(response.status).not.toBe(200);
    expect(sql('select id from oauth_consent where user_id=? and client_id=?', userId, clientId)).toHaveLength(reconnect ? 1 : 0);
  } finally { spy.mockRestore(); }
});

test('a new account continues a signed authorization request to consent', async () => {
  const intent = await authorize();
  const signup = await call('/sign-up/email', { name: 'New OAuth reader', email: 'new-oauth-reader@example.test', password: 'OAuthFixture#2026', oauth_query: intent.query });
  expect(signup.status).toBe(200);
  const response = await signup.json();
  expect(response.redirect).toBe(true);
  expect(new URL(response.url, origin).pathname).toBe('/oauth/consent');
});

test('offline refresh remains usable after the browser session expires', async () => {
  const token = await grant();
  const database = new Database(databasePath);
  database.prepare('update session set expires_at=? where user_id=?').run(Date.now() - 1000, userId);
  database.close();
  const renewed = await call('/oauth2/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token.refresh_token, resource }, undefined, true);
  expect(renewed.status).toBe(200);
  const result = await renewed.json();
  expect(await principal(result.access_token)).toMatchObject({ userId });
});

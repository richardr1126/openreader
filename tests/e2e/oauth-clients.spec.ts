import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { declineOptionalCookies } from './support/onboarding';

test('connects scoped apps with PKCE and device approval, then revokes their access', async ({ page, playwright, request }, testInfo) => {
  // The native client has its own transport, independent of browser cookies.
  const discovery = await request.get('/.well-known/oauth-protected-resource/api/v1');
  expect(discovery.status()).toBe(200);
  const { resource, authorization_servers: [issuer] } = await discovery.json();
  const server = await request.get('/.well-known/oauth-authorization-server/api/auth');
  expect(server.status()).toBe(200);
  const metadata = await server.json();
  expect(metadata.issuer).toBe(issuer);
  const redirect = 'http://127.0.0.1:43210/callback';
  const name = `Reader tool ${testInfo.project.name}`;
  const registered = await request.post(metadata.registration_endpoint, { data: {
    client_name: name, application_type: 'native', redirect_uris: [redirect], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
    response_types: ['code'], scope: 'documents:read offline_access', resources: [resource],
  } });
  expect(registered.status()).toBe(201);
  const { client_id: clientId } = await registered.json();
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('hex');
  const authorize = new URL(metadata.authorization_endpoint);
  authorize.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code',
    scope: 'documents:read offline_access', resource, state, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), prompt: 'consent' }).toString();
  await page.route(`${redirect}**`, route => route.fulfill({ contentType: 'text/html', body: '<h1>Returned to reader tool</h1>' }));
  await page.goto(authorize.toString());
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await declineOptionalCookies(page);
  await page.getByPlaceholder('me@example.com').fill('admin-e2e@example.test');
  await page.getByPlaceholder('Password', { exact: true }).fill('TestAccount#2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: `${name} wants to connect`, exact: true })).toBeVisible();
  await expect(page.getByText('Unverified app', { exact: true })).toBeVisible();
  await expect(page.getByText('127.0.0.1:43210', { exact: true })).toBeVisible();
  await expect(page.getByText('Read your documents, folders, voices and audiobooks', { exact: true })).toBeVisible();
  await expect(page.getByText(/OpenReader can’t confirm who made this app/)).toBeVisible();
  // Approving from the wrong account is a mistake a person can only catch here.
  await page.getByRole('button', { name: 'Switch account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByPlaceholder('me@example.com').fill('admin-e2e@example.test');
  await page.getByPlaceholder('Password', { exact: true }).fill('TestAccount#2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('First Administrator', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Allow access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Returned to reader tool' })).toBeVisible();
  const callback = new URL(page.url());
  expect(callback.searchParams.get('state')).toBe(state);
  expect(callback.searchParams.get('iss')).toBe(issuer);
  const exchanged = await request.post(metadata.token_endpoint, { form: { grant_type: 'authorization_code',
    client_id: clientId, redirect_uri: redirect, code: callback.searchParams.get('code')!, code_verifier: verifier, resource } });
  expect(exchanged.status()).toBe(200);
  const tokens = await exchanged.json();
  const bearer = { Authorization: `Bearer ${tokens.access_token}` };
  expect((await page.request.get('/api/v1/me', { headers: bearer })).status()).toBe(200);
  // Even an attached administrator cookie cannot widen the token's read scope.
  expect((await page.request.post('/api/v1/documents', { headers: bearer, data: {} })).status()).toBe(403);
  const external = await playwright.request.newContext({ extraHTTPHeaders: bearer });
  try {
    expect((await external.get(`${new URL(resource).origin}/api/admin/settings`)).status()).toBe(401);
    expect((await external.get(`${new URL(resource).origin}/api/user/connected-apps`)).status()).toBe(403);
  } finally { await external.dispose(); }

  async function disconnect() {
    await page.goto('/app/settings?section=account');
    const apps = page.getByRole('region', { name: 'Connected apps', exact: true });
    const app = apps.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) });
    await expect(app.getByText('127.0.0.1:43210', { exact: true })).toBeVisible();
    await expect(app.getByText('Read your documents, folders, voices and audiobooks', { exact: true })).toBeVisible();
    await app.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(apps.getByRole('heading', { name, exact: true })).toHaveCount(0);
  }
  await disconnect();
  expect((await page.request.get('/api/v1/me', { headers: bearer })).status()).toBe(401);
  expect((await request.post(metadata.token_endpoint, { form: { grant_type: 'refresh_token',
    client_id: clientId, refresh_token: tokens.refresh_token, resource } })).status()).toBe(400);

  const requested = await request.post(metadata.device_authorization_endpoint, { form: {
    client_id: clientId, scope: 'documents:read offline_access', resource,
  } });
  expect(requested.status()).toBe(200);
  const device = await requested.json();
  await page.goto(device.verification_uri_complete);
  await expect(page.getByRole('heading', { name: `${name} wants to connect`, exact: true })).toBeVisible();
  await expect(page.getByText(device.user_code, { exact: true })).toBeVisible();
  await expect(page.getByText(/Only allow a code shown by a device you are using/)).toBeVisible();
  await page.getByRole('button', { name: 'Use a different code', exact: true }).click();
  await page.getByRole('textbox', { name: 'Code shown on your device' }).fill(device.user_code);
  await page.getByRole('button', { name: 'Check code', exact: true }).click();
  await page.getByRole('button', { name: 'Allow access', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Device approved. Return to your device to finish connecting.');
  const deviceToken = await request.post(metadata.token_endpoint, { form: {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: clientId, device_code: device.device_code, resource,
  } });
  expect(deviceToken.status()).toBe(200);
  const connected = await deviceToken.json();
  const deviceBearer = { Authorization: `Bearer ${connected.access_token}` };
  expect((await page.request.get('/api/v1/me', { headers: deviceBearer })).status()).toBe(200);
  // Reconnecting must never revive the previous grant's JWT.
  expect((await page.request.get('/api/v1/me', { headers: bearer })).status()).toBe(401);
  await disconnect();
  expect((await page.request.get('/api/v1/me', { headers: deviceBearer })).status()).toBe(401);
});

test('signing in from a device link returns to the same code', async ({ page }) => {
  const userCode = 'ABCD-EFGH';
  await page.goto(`/oauth/device?user_code=${userCode}`);
  await expect(page.getByRole('heading', { name: 'Sign in to connect', exact: true })).toBeVisible();
  await declineOptionalCookies(page);
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByPlaceholder('me@example.com').fill('admin-e2e@example.test');
  await page.getByPlaceholder('Password', { exact: true }).fill('TestAccount#2026');
  await page.getByPlaceholder('Password', { exact: true }).press('Enter');
  await expect(page).toHaveURL(/\/oauth\/device\?user_code=ABCD-EFGH$/);
  await expect(page.getByRole('textbox', { name: 'Code shown on your device' })).toHaveValue(userCode);
});

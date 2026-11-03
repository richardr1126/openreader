import { NextRequest } from 'next/server';
import { beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ fetchExternal: vi.fn(), logo: vi.fn() }));
vi.mock('@/lib/server/external-fetch', () => ({ fetchExternal: state.fetchExternal }));
vi.mock('@/lib/server/auth/connected-apps', () => ({
  oauthClientLogo: state.logo,
  oauthCookieRequest: async (_request: NextRequest, run: () => Promise<Response>) => {
    const response = await run();
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  },
}));
import { GET } from '@/app/api/oauth/client-logo/route';
import { fetchOAuthClientLogo, sniffLogoContentType } from '@/lib/server/auth/oauth-client-logo';
import { oauthClientLogoSource, oauthClientLogoUrl } from '@/lib/server/auth/oauth-values';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const verified = { clientId: 'https://app.example/client.json', clientDiscoveryId: 'cimd', icon: 'https://app.example/logo.png' };

beforeEach(() => { state.fetchExternal.mockReset(); state.logo.mockReset(); });

test('a verified client with a same-origin HTTPS logo gets a URL on our own domain', () => {
  expect(oauthClientLogoUrl(verified)).toBe(`/api/oauth/client-logo?client_id=${encodeURIComponent(verified.clientId)}`);
});

test.each([
  ['a registered client that declares a logo', { clientId: 'generated-id', clientDiscoveryId: null, icon: 'https://app.example/logo.png' }],
  ['an HTTPS client ID without CIMD discovery', { ...verified, clientDiscoveryId: null }],
  ['a verified client with no logo', { ...verified, icon: null }],
  ['a logo on another origin', { ...verified, icon: 'https://cdn.example/logo.png' }],
  ['a logo on another port', { ...verified, icon: 'https://app.example:8443/logo.png' }],
  ['a plain HTTP logo', { ...verified, icon: 'http://app.example/logo.png' }],
  ['a logo URL with credentials', { ...verified, icon: 'https://user:pass@app.example/logo.png' }],
  ['a malformed logo URL', { ...verified, icon: 'not a url' }],
])('%s gets no logo and is never fetched', async (_name, client) => {
  expect(oauthClientLogoSource(client)).toBeNull();
  expect(oauthClientLogoUrl(client)).toBeNull();
  await expect(fetchOAuthClientLogo(client)).resolves.toBeNull();
  expect(state.fetchExternal).not.toHaveBeenCalled();
});

test('types come from the bytes, and SVG and HTML are refused', () => {
  expect(sniffLogoContentType(png)).toBe('image/png');
  expect(sniffLogoContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
  expect(sniffLogoContentType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  expect(sniffLogoContentType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  expect(sniffLogoContentType(Buffer.from('<!doctype html>'))).toBeNull();
  expect(sniffLogoContentType(Buffer.alloc(0))).toBeNull();
});

test('a verified logo is fetched within limits that keep every hop on the client origin', async () => {
  state.fetchExternal.mockResolvedValue({ body: png, finalUrl: verified.icon });
  await expect(fetchOAuthClientLogo(verified)).resolves.toEqual({ bytes: png, contentType: 'image/png' });
  const [url, options] = state.fetchExternal.mock.calls[0];
  expect(url).toBe(verified.icon);
  expect(options.maxBytes).toBeLessThanOrEqual(256 * 1024);
  expect(options.timeoutMs).toBeLessThanOrEqual(3000);
  expect(options.allowsUrl(new URL('https://app.example/moved.png'))).toBe(true);
  expect(options.allowsUrl(new URL('https://cdn.example/logo.png'))).toBe(false);
  expect(options.allowsUrl(new URL('http://app.example/logo.png'))).toBe(false);
  for (const type of ['image/png', 'image/jpeg', 'image/webp; charset=binary']) expect(options.acceptsContentType(type)).toBe(true);
  for (const type of ['image/svg+xml', 'text/html', '']) expect(options.acceptsContentType(type)).toBe(false);
});

test('a failed fetch or a body that is not an image means no logo', async () => {
  state.fetchExternal.mockRejectedValue(new Error('Request timed out'));
  await expect(fetchOAuthClientLogo(verified)).resolves.toBeNull();
  state.fetchExternal.mockResolvedValue({ body: Buffer.from('<svg/>'), finalUrl: verified.icon });
  await expect(fetchOAuthClientLogo(verified)).resolves.toBeNull();
});

const logoRequest = () => new NextRequest(`http://localhost/api/oauth/client-logo?client_id=${encodeURIComponent(verified.clientId)}`);

test('the route serves the checked bytes as an inert, cached image', async () => {
  state.logo.mockResolvedValue({ bytes: png, contentType: 'image/png' });
  const response = await GET(logoRequest());
  expect(response.status).toBe(200);
  expect(state.logo).toHaveBeenCalledWith(verified.clientId);
  expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
  expect(response.headers.get('content-type')).toBe('image/png');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  expect(response.headers.get('cache-control')).toBe('private, max-age=86400');
});

test('the route answers a missing logo with a short-lived 404', async () => {
  state.logo.mockResolvedValue(null);
  const response = await GET(logoRequest());
  expect(response.status).toBe(404);
  expect(response.headers.get('cache-control')).toBe('private, max-age=300');
});

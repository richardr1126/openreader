import { EventEmitter } from 'node:events';
import https from 'node:https';
import { afterEach, expect, test, vi } from 'vitest';
import { fetchExternal, type ExternalFetchOptions } from '@/lib/server/external-fetch';

const options: ExternalFetchOptions = { maxBytes: 16, timeoutMs: 1000, maxRedirects: 2, accept: 'image/png', acceptsContentType: type => type === 'image/png',
  allowsUrl: url => url.protocol === 'https:' && url.origin === 'https://app.example',
  messages: { status: status => `status ${status}`, contentType: 'bad type', tooLarge: 'too large', tooManyRedirects: 'too many redirects' } };

function respond(...responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>) {
  return vi.spyOn(https, 'request').mockImplementation(((_options: unknown, callback: (res: EventEmitter) => void) => {
    const req = Object.assign(new EventEmitter(), { end: () => {
      const next = responses.shift()!;
      const res = Object.assign(new EventEmitter(), { statusCode: next.status, headers: next.headers ?? {}, resume: () => {} });
      callback(res);
      if (next.body) res.emit('data', Buffer.from(next.body));
      res.emit('end');
    }, destroy: () => {} });
    return req;
  }) as never);
}

afterEach(() => { vi.restoreAllMocks(); });

test('the SSRF agent refuses a private address', async () => {
  await expect(fetchExternal('https://127.0.0.1/logo.png', { ...options, allowsUrl: undefined })).rejects.toThrow('disallowed by policy');
});

test('returns the body from an allowed URL, following a redirect on the same origin', async () => {
  const request = respond({ status: 302, headers: { location: '/moved.png' } }, { status: 200, headers: { 'content-type': 'image/png' }, body: 'bytes' });
  const result = await fetchExternal('https://app.example/logo.png', options);
  expect(result.body.toString()).toBe('bytes');
  expect(result.finalUrl).toBe('https://app.example/moved.png');
  expect(request).toHaveBeenCalledTimes(2);
});

test('a URL or a redirect the caller refuses is never requested', async () => {
  const request = respond({ status: 302, headers: { location: 'https://cdn.example/logo.png' } });
  await expect(fetchExternal('https://app.example/logo.png', options)).rejects.toThrow('not allowed');
  expect(request).toHaveBeenCalledTimes(1);
  await expect(fetchExternal('http://app.example/logo.png', options)).rejects.toThrow('not allowed');
  expect(request).toHaveBeenCalledTimes(1);
});

test('enforces the type, size and redirect limits', async () => {
  respond({ status: 200, headers: { 'content-type': 'image/svg+xml' } });
  await expect(fetchExternal('https://app.example/a', options)).rejects.toThrow('bad type');
  vi.restoreAllMocks();
  respond({ status: 200, headers: { 'content-type': 'image/png', 'content-length': '17' } });
  await expect(fetchExternal('https://app.example/a', options)).rejects.toThrow('too large');
  vi.restoreAllMocks();
  respond({ status: 200, headers: { 'content-type': 'image/png' }, body: 'x'.repeat(17) });
  await expect(fetchExternal('https://app.example/a', options)).rejects.toThrow('too large');
  vi.restoreAllMocks();
  respond(...Array.from({ length: 3 }, () => ({ status: 302, headers: { location: '/next' } })));
  await expect(fetchExternal('https://app.example/a', options)).rejects.toThrow('too many redirects');
});

import { describe, expect, test } from 'vitest';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server.js';
import { NextRequest } from 'next/server';

import { config, middleware } from '../../src/middleware';

describe('middleware matcher', () => {
  test('leaves the authenticated raw blob upload outside middleware body buffering', () => {
    expect(unstable_doesMiddlewareMatch({
      config,
      nextConfig: {},
      url: 'http://localhost/api/v1/uploads/upload-token/file',
    })).toBe(false);
  });

  test('continues matching upload support routes and normal application requests', () => {
    for (const url of [
      'http://localhost/api/v1/documents',
      'http://localhost/api/v1/uploads/upload-token/events',
      'http://localhost/app',
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
    }
  });

  test('passes service-authenticated compute callbacks to their bearer-token route', () => {
    const previous = process.env.RICHARDRDEV_PRODUCTION;
    process.env.RICHARDRDEV_PRODUCTION = 'true';
    try {
      for (const path of [
        '/api/internal/compute/tts-credentials',
        '/api/internal/compute/email-execution',
        '/api/internal/compute/limits/policy',
        '/api/internal/compute/limits/consume',
        '/api/internal/compute/limits/complete',
      ]) {
        const response = middleware(new NextRequest(`http://localhost${path}`, { method: 'POST' }));
        expect(response.headers.get('x-middleware-next')).toBe('1');
      }
    } finally {
      if (previous === undefined) delete process.env.RICHARDRDEV_PRODUCTION;
      else process.env.RICHARDRDEV_PRODUCTION = previous;
    }
  });
  test('the region gate answers v1 in the API error shape', async () => {
    const previous = process.env.RICHARDRDEV_PRODUCTION;
    process.env.RICHARDRDEV_PRODUCTION = 'true';
    try {
      const gated = (pathname: string) => middleware(new NextRequest(`http://localhost${pathname}`, {
        headers: { 'x-vercel-ip-country': 'DE' },
      }));
      const v1 = gated('/api/v1/documents');
      expect(v1.status).toBe(451);
      expect(await v1.json()).toEqual({ error: { code: 'REGION_UNAVAILABLE', message: expect.any(String) } });
      expect(await gated('/api/documents').json()).toEqual({ error: expect.any(String) });
    } finally {
      if (previous === undefined) delete process.env.RICHARDRDEV_PRODUCTION;
      else process.env.RICHARDRDEV_PRODUCTION = previous;
    }
  });

  test('serves the app privacy policies and downloads outside the production region gate without a session', () => {
    const previous = process.env.RICHARDRDEV_PRODUCTION;
    process.env.RICHARDRDEV_PRODUCTION = 'true';
    try {
      for (const pathname of ['/ios-privacy', '/desktop-privacy', '/download']) {
        const page = middleware(new NextRequest(`http://localhost${pathname}`, {
          headers: { 'x-vercel-ip-country': 'DE' },
        }));
        expect(page.headers.get('x-middleware-next')).toBe('1');
      }

      const webPolicy = middleware(new NextRequest('http://localhost/privacy', {
        headers: { 'x-vercel-ip-country': 'DE' },
      }));
      expect(webPolicy.status).toBe(451);
    } finally {
      if (previous === undefined) delete process.env.RICHARDRDEV_PRODUCTION;
      else process.env.RICHARDRDEV_PRODUCTION = previous;
    }
  });
});

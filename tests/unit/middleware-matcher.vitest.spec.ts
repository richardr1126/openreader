import { describe, expect, test } from 'vitest';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server.js';
import { NextRequest } from 'next/server';

import { config, middleware } from '../../src/middleware';

describe('middleware matcher', () => {
  test('leaves the authenticated raw blob upload outside middleware body buffering', () => {
    expect(unstable_doesMiddlewareMatch({
      config,
      nextConfig: {},
      url: 'http://localhost/api/documents/blob/upload?token=upload-token',
    })).toBe(false);
  });

  test('continues matching upload support routes and normal application requests', () => {
    for (const url of [
      'http://localhost/api/documents/blob/upload/finalize',
      'http://localhost/api/documents/blob/upload/events',
      'http://localhost/app',
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true);
    }
  });

  test('passes service-authenticated compute callbacks to their bearer-token route', () => {
    const previous = process.env.RICHARDRDEV_PRODUCTION;
    process.env.RICHARDRDEV_PRODUCTION = 'true';
    try {
      const response = middleware(new NextRequest(
        'http://localhost/api/internal/compute/tts-credentials',
        { method: 'POST' },
      ));
      expect(response.headers.get('x-middleware-next')).toBe('1');
    } finally {
      if (previous === undefined) delete process.env.RICHARDRDEV_PRODUCTION;
      else process.env.RICHARDRDEV_PRODUCTION = previous;
    }
  });
});

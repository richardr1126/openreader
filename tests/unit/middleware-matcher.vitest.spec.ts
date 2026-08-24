import { describe, expect, test } from 'vitest';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server.js';

import { config } from '../../src/middleware';

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
});

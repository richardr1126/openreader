import { describe, expect, test } from 'vitest';
import type { NextRequest } from 'next/server';
import { getClientIp } from '../../src/lib/server/rate-limit/request-ip';
import { withEnv } from './support/env';

function makeReq(headers: Record<string, string>, ip?: string): NextRequest {
  const req = { headers: new Headers(headers) } as Partial<NextRequest> & { ip?: string };
  if (ip) req.ip = ip;
  return req as NextRequest;
}

describe('getClientIp', () => {
  test('never trusts the left-most (client-prependable) X-Forwarded-For entry', async () => {
    await withEnv({ VERCEL: undefined }, () => {
      // Attacker prepends a spoofed value; the real connecting IP is the right-most hop.
      const req = makeReq({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' });
      expect(getClientIp(req)).toBe('9.9.9.9');
    });
  });

  test('prefers x-real-ip over X-Forwarded-For', async () => {
    await withEnv({ VERCEL: undefined }, () => {
      const req = makeReq({ 'x-real-ip': '5.5.5.5', 'x-forwarded-for': '1.2.3.4, 9.9.9.9' });
      expect(getClientIp(req)).toBe('5.5.5.5');
    });
  });

  test('prefers x-vercel-forwarded-for when running on Vercel', async () => {
    await withEnv({ VERCEL: '1' }, () => {
      const req = makeReq({
        'x-vercel-forwarded-for': '8.8.8.8',
        'x-real-ip': '5.5.5.5',
        'x-forwarded-for': '1.2.3.4',
      });
      expect(getClientIp(req)).toBe('8.8.8.8');
    });
  });

  test('ignores x-vercel-forwarded-for when not on Vercel', async () => {
    await withEnv({ VERCEL: undefined }, () => {
      // A self-hosted deployment must not trust a client-supplied x-vercel-* header.
      const req = makeReq({ 'x-vercel-forwarded-for': '8.8.8.8', 'x-real-ip': '5.5.5.5' });
      expect(getClientIp(req)).toBe('5.5.5.5');
    });
  });

  test('falls back to the connecting address when no proxy headers are present', async () => {
    await withEnv({ VERCEL: undefined }, () => {
      const req = makeReq({}, '10.0.0.1');
      expect(getClientIp(req)).toBe('10.0.0.1');
    });
  });
});

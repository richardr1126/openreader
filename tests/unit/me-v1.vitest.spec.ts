import { NextRequest } from 'next/server';
import { beforeEach, expect, test, vi } from 'vitest';
const state = vi.hoisted(() => ({ userId: 'alice' as string | null, anonymous: false, usage: vi.fn(), device: vi.fn() }));
vi.mock('@/lib/server/auth/auth', () => ({ getAuthContext: async () => ({ userId: state.userId, user: { isAnonymous: state.anonymous } }), getTrustedOrigins: () => [] }));
vi.mock('@/lib/server/runtime-config', () => ({ getResolvedRuntimeConfig: async () => ({ computeLimitPolicies: { actions: { tts_synthesis: { enabled: true } } } }) }));
vi.mock('@/lib/server/compute-limits/usage', () => ({ getComputeUsage: state.usage }));
import { GET } from '@/app/api/v1/me/route';
beforeEach(() => {
  state.userId = 'alice'; state.anonymous = false;
  state.device.mockReset().mockReturnValue({ deviceId: 'test', didCreate: true });
  state.usage.mockReset().mockResolvedValue({ allowed: true, buckets: [
    { scope: 'user', used: 10, limit: 100, remaining: 90, resetAt: 1000 },
    { scope: 'site', used: 95, limit: 100, remaining: 5, resetAt: 2000 },
  ] });
});
test('returns identity, scopes and the binding usage limit without exposing bucket keys', async () => {
  const response = await GET(new NextRequest('http://localhost/api/v1/me'));
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ id: 'alice', isAnonymous: false, scopes: ['documents:read', 'documents:write', 'audio:generate'],
    computeLimits: { allowed: true, currentCount: 95, limit: 100, remainingChars: 5, resetTimeMs: 2000, userType: 'authenticated', enabled: true } });
  expect(state.device).not.toHaveBeenCalled();
});
test('keys guest quota checks only on the user and creates no device cookie', async () => {
  state.anonymous = true;
  const response = await GET(new NextRequest('http://localhost/api/v1/me'));
  expect(state.usage).toHaveBeenCalledWith(expect.objectContaining({ subject: { userId: 'alice', isAnonymous: true } }));
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(await response.json()).not.toHaveProperty('deviceId');
});
test('unauthenticated introspection is rejected before reading usage', async () => {
  state.userId = null;
  expect((await GET(new NextRequest('http://localhost/api/v1/me'))).status).toBe(401);
  expect(state.usage).not.toHaveBeenCalled();
});

import { afterEach, describe, expect, test, vi } from 'vitest';
import { resolveTtsPlaybackPlan } from '../../src/lib/client/api/tts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveTtsPlaybackPlan', () => {
  test('treats a 202 snapshot as active work with server retry guidance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ planId: 'plan-1', status: 'running' }),
      { status: 202, headers: { 'Retry-After': '2' } },
    )));
    await expect(resolveTtsPlaybackPlan('/plan/1')).resolves.toEqual({
      status: 'running',
      retryAfterMs: 2_000,
    });
  });

  test('surfaces terminal worker failure instead of returning an empty plan', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: 'planning failed', code: 'PLAN_FAILED' }),
      { status: 409 },
    )));
    await expect(resolveTtsPlaybackPlan('/plan/1')).rejects.toMatchObject({
      message: 'planning failed',
      code: 'PLAN_FAILED',
      status: 409,
    });
  });
});

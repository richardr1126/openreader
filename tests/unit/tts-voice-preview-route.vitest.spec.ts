import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const hoisted = vi.hoisted(() => ({
  auth: vi.fn(),
  synthesize: vi.fn(),
  reserve: vi.fn(),
  activate: vi.fn(async () => undefined),
  finish: vi.fn(async () => undefined),
  consume: vi.fn(),
}));

vi.mock('@/lib/server/auth/auth', () => ({ requireAuthContext: hoisted.auth }));

vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: vi.fn(() => true),
  ComputeWorkerClient: class ComputeWorkerClient {
    synthesizeTtsVoicePreview = hoisted.synthesize;
  },
}));

vi.mock('@/lib/server/admin/settings', () => ({
  getRuntimeConfig: vi.fn(async () => ({ computeLimitPolicies: { actions: {} } })),
}));

vi.mock('@/lib/server/logger', () => ({
  createRequestLogger: vi.fn(() => ({ logger: { warn: vi.fn(), error: vi.fn() } })),
  errorToLog: (error: unknown) => ({ message: String(error), stack: (error as Error)?.stack }),
}));

vi.mock('@/lib/server/compute-limits/admission', () => ({
  reserveComputeAdmission: hoisted.reserve,
  activateComputeAdmission: hoisted.activate,
  finishComputeAdmission: hoisted.finish,
}));

vi.mock('@/lib/server/compute-limits/usage', () => ({ consumeComputeUsage: hoisted.consume }));

vi.mock('@/lib/server/rate-limit/request-ip', () => ({ getClientIp: vi.fn(() => '127.0.0.1') }));

vi.mock('@/lib/server/rate-limit/device-id', () => ({
  getOrCreateDeviceId: vi.fn(() => ({ deviceId: 'device-1', didCreate: false })),
  setDeviceIdCookie: vi.fn(),
}));

const { POST } = await import('@/app/api/tts/voice-preview/route');

const SETTINGS = {
  providerRef: 'kokoro-shared',
  providerType: 'custom-openai',
  ttsModel: 'kokoro',
  voice: 'af_bella',
  nativeSpeed: 1.2,
  language: 'en',
};

function request(body: unknown) {
  return new NextRequest('http://localhost/api/tts/voice-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/tts/voice-preview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.finish.mockResolvedValue(undefined);
    hoisted.activate.mockResolvedValue(undefined);
    hoisted.auth.mockResolvedValue({ userId: 'user-1', user: { id: 'user-1', isAnonymous: false }, session: {} });
    hoisted.reserve.mockResolvedValue({ allowed: true, admissionId: 'adm-1', retryAfterMs: 0 });
    hoisted.consume.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
    hoisted.synthesize.mockResolvedValue({ ok: true, audio: new TextEncoder().encode('mp3').buffer });
  });

  test('requires a signed-in session before doing any work', async () => {
    hoisted.auth.mockResolvedValue(new Response(null, { status: 401 }));
    const response = await POST(request({ settings: SETTINGS, text: 'Hello.' }));
    expect(response.status).toBe(401);
    expect(hoisted.reserve).not.toHaveBeenCalled();
    expect(hoisted.synthesize).not.toHaveBeenCalled();
  });

  test.each([
    ['missing settings', { text: 'Hello.' }],
    ['empty text', { settings: SETTINGS, text: '   ' }],
    ['oversized text', { settings: SETTINGS, text: 'x'.repeat(301) }],
    ['out-of-range speed', { settings: { ...SETTINGS, nativeSpeed: 9 }, text: 'Hello.' }],
    ['unknown provider type', { settings: { ...SETTINGS, providerType: 'nope' }, text: 'Hello.' }],
  ])('rejects %s', async (_name, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(hoisted.reserve).not.toHaveBeenCalled();
  });

  test('is limited by the interactive playback admission without a session key', async () => {
    hoisted.reserve.mockResolvedValue({ allowed: false, admissionId: null, retryAfterMs: 4_000 });
    const response = await POST(request({ settings: SETTINGS, text: 'Hello.' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('4');
    const reservation = hoisted.reserve.mock.calls[0][0];
    expect(reservation.action).toBe('tts_playback');
    expect(reservation.requestKey).toMatch(/^tts-preview:/);
    expect(hoisted.synthesize).not.toHaveBeenCalled();
  });

  test('charges preview characters and cancels the admission when usage is exhausted', async () => {
    hoisted.consume.mockResolvedValue({ allowed: false, retryAfterMs: 60_000 });
    const response = await POST(request({ settings: SETTINGS, text: 'Hello.' }));
    expect(response.status).toBe(429);
    expect(hoisted.consume).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tts_synthesis',
      metric: 'characters',
      units: 'Hello.'.length,
      admissionId: 'adm-1',
    }));
    expect(hoisted.finish).toHaveBeenCalledWith({ admissionId: 'adm-1', state: 'cancelled' });
    expect(hoisted.synthesize).not.toHaveBeenCalled();
  });

  test('returns uncached MP3 audio and finishes the admission', async () => {
    const response = await POST(request({ settings: SETTINGS, text: '  Hello.  ' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.text()).toBe('mp3');
    expect(hoisted.synthesize).toHaveBeenCalledWith(
      { settings: SETTINGS, text: 'Hello.' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(hoisted.finish).toHaveBeenCalledWith({ admissionId: 'adm-1', state: 'finished' });
  });

  test('relays a worker rejection by code', async () => {
    hoisted.synthesize.mockResolvedValue({ ok: false, status: 503, code: 'PROVIDER_UNAVAILABLE', retryAfterMs: null });
    const response = await POST(request({ settings: SETTINGS, text: 'Hello.' }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(hoisted.finish).toHaveBeenCalledWith({ admissionId: 'adm-1', state: 'cancelled' });
  });
});

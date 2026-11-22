import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const hoisted = vi.hoisted(() => ({
  principal: vi.fn(),
  resolve: vi.fn(),
  prefRows: [] as { dataJson: unknown }[],
  synthesize: vi.fn(),
  reserve: vi.fn(),
  activate: vi.fn(async () => undefined),
  finish: vi.fn(async () => undefined),
  consume: vi.fn(),
}));

vi.mock('@/lib/server/api/principal', () => ({ resolveApiPrincipal: hoisted.principal }));
vi.mock('@openreader/database', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => hoisted.prefRows }) }) }) },
}));
vi.mock('@/lib/server/reader/bootstrap', () => ({ storedRecord: (value: unknown) => (value ?? {}) as Record<string, unknown> }));
vi.mock('@/lib/server/reader/playback', () => ({ resolveSpeechSettings: hoisted.resolve }));
vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: vi.fn(() => true),
  ComputeWorkerClient: class ComputeWorkerClient {
    synthesizeTtsSpeech = hoisted.synthesize;
  },
}));
vi.mock('@/lib/server/admin/settings', () => ({
  getRuntimeConfig: vi.fn(async () => ({ computeLimitPolicies: { actions: {} } })),
}));
vi.mock('@/lib/server/logger', () => ({
  createRequestLogger: vi.fn(() => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } })),
  errorToLog: (error: unknown) => ({ message: String(error), stack: (error as Error)?.stack }),
}));
vi.mock('@/lib/server/compute-limits/admission', () => ({
  reserveComputeAdmission: hoisted.reserve,
  activateComputeAdmission: hoisted.activate,
  finishComputeAdmission: hoisted.finish,
}));
vi.mock('@/lib/server/compute-limits/usage', () => ({ consumeComputeUsage: hoisted.consume }));

const { POST } = await import('@/app/api/v1/speech/route');

const RESOLVED = {
  providerRef: 'kokoro-shared',
  providerType: 'custom-openai',
  ttsModel: 'kokoro',
  voice: 'af_bella',
  nativeSpeed: 1.2,
  language: 'en-US',
  speechText: { citations: false, brackets: 'speak' },
};

function request(body: unknown) {
  return new NextRequest('http://localhost/api/v1/speech', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/v1/speech', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.prefRows = [{ dataJson: { voice: 'af_bella' } }];
    hoisted.principal.mockResolvedValue({ userId: 'user-1', isAnonymous: false, scopes: ['audio:generate'], clientId: 'https://app.example/client.json' });
    hoisted.resolve.mockResolvedValue({ settings: RESOLVED, language: 'en-US', preferences: {} });
    hoisted.reserve.mockResolvedValue({ allowed: true, admissionId: 'adm-1', retryAfterMs: 0 });
    hoisted.consume.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
    hoisted.synthesize.mockResolvedValue({ ok: true, audio: new TextEncoder().encode('mp3').buffer });
  });

  test('needs the audio:generate scope before doing any work', async () => {
    hoisted.principal.mockResolvedValue(new Response(null, { status: 403 }));
    const response = await POST(request({ text: 'Hello.' }));
    expect(response.status).toBe(403);
    expect(hoisted.principal).toHaveBeenCalledWith(expect.anything(), 'audio:generate');
    expect(hoisted.reserve).not.toHaveBeenCalled();
  });

  test.each([
    ['empty text', { text: '   ' }],
    ['text past the limit', { text: 'x'.repeat(2001) }],
    ['an unknown field', { text: 'Hi.', settings: RESOLVED }],
    ['a bad speed', { text: 'Hi.', modelSpeed: 9 }],
    ['a blank voice', { text: 'Hi.', voice: ' ' }],
    ['a model ID longer than the worker takes', { text: 'Hi.', model: 'm'.repeat(257) }],
    // 129 code points pass the schema's maxLength, but they are 258 UTF-16 units.
    ['a model ID over 256 UTF-16 units', { text: 'Hi.', model: '\u{1F600}'.repeat(129) }],
  ])('rejects %s without charging', async (_name, body) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('REQUEST_INVALID');
    expect(hoisted.reserve).not.toHaveBeenCalled();
  });

  test('speaks with the saved voice, charges the characters and keeps nothing', async () => {
    const response = await POST(request({ text: '  Hello there.  ', voice: 'af_sky', modelSpeed: 1.234 }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(hoisted.resolve).toHaveBeenCalledWith('user-1', expect.any(Object), { voice: 'af_bella' }, null,
      expect.objectContaining({ voice: 'af_sky', modelSpeed: 1.23, checkVoice: true }));
    expect(hoisted.consume).toHaveBeenCalledWith(expect.objectContaining({
      action: 'tts_synthesis', metric: 'characters', units: 'Hello there.'.length,
      subject: { userId: 'user-1', isAnonymous: false },
    }));
    // Only the fields the worker takes: reader-only settings stay behind.
    const [input] = hoisted.synthesize.mock.calls[0];
    expect(input).toEqual({ text: 'Hello there.', userId: 'user-1', settings: {
      providerRef: 'kokoro-shared', providerType: 'custom-openai', ttsModel: 'kokoro', voice: 'af_bella', nativeSpeed: 1.2, language: 'en-US',
    } });
    expect(hoisted.finish).toHaveBeenCalledWith({ admissionId: 'adm-1', state: 'finished' });
  });

  test('reports a voice the provider lacks as a bad request and an unreachable provider as unavailable', async () => {
    hoisted.resolve.mockResolvedValueOnce({ error: 'That voice is not available.', invalid: true });
    expect((await POST(request({ text: 'Hi.', voice: 'nope' }))).status).toBe(400);
    hoisted.resolve.mockResolvedValueOnce({ error: 'The playback provider is unavailable.' });
    const unavailable = await POST(request({ text: 'Hi.' }));
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(hoisted.reserve).not.toHaveBeenCalled();
  });

  test('stops at the usage limit and releases its admission', async () => {
    hoisted.consume.mockResolvedValue({ allowed: false, retryAfterMs: 30_000 });
    const response = await POST(request({ text: 'Hi.' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(hoisted.synthesize).not.toHaveBeenCalled();
    expect(hoisted.finish).toHaveBeenCalledWith({ admissionId: 'adm-1', state: 'cancelled' });
  });

  test('relays a worker rejection by code without its details', async () => {
    hoisted.synthesize.mockResolvedValue({ ok: false, status: 503, code: 'PROVIDER_UNAVAILABLE', retryAfterMs: null });
    const response = await POST(request({ text: 'Hi.' }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: 'PROVIDER_UNAVAILABLE', message: 'Speech is unavailable right now.' } });
  });

  test('suggests a delay when a busy worker gives none', async () => {
    hoisted.synthesize.mockResolvedValue({ ok: false, status: 429, code: 'PROVIDER_BUSY', retryAfterMs: null });
    const response = await POST(request({ text: 'Hi.' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('5');
  });

  test('refuses an oversized body before reading it all', async () => {
    const response = await POST(request({ text: 'Hi.', pad: 'x'.repeat(40 * 1024) }));
    expect(response.status).toBe(413);
    expect(hoisted.reserve).not.toHaveBeenCalled();
  });
});

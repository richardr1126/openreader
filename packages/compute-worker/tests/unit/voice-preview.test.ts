import Fastify from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { TtsCredentialBrokerResponse } from '@openreader/tts/credential-broker';
import {
  synthesizeTtsVoicePreview,
  TTS_VOICE_PREVIEW_MAX_AUDIO_BYTES,
  TtsVoicePreviewTooLargeError,
  type TtsVoicePreviewDeps,
} from '../../src/jobs/playback/voice-preview';
import { TtsCredentialBrokerClientError } from '../../src/jobs/tts-credential-broker-error';
import { registerVoicePreviewRoutes } from '../../src/api/routes/playback/voice-preview';
import type { ComputeWorkerRouteContext } from '../../src/api/route-context';

const API_KEY = 'sk-preview-secret-never-leaks';
const CREDS: TtsCredentialBrokerResponse = {
  providerRef: 'kokoro-shared',
  providerType: 'custom-openai',
  apiKey: API_KEY,
  baseUrl: 'http://kokoro.internal/v1',
  defaultModel: 'kokoro',
  defaultInstructions: null,
};
const SETTINGS = {
  providerRef: 'kokoro-shared',
  providerType: 'custom-openai' as const,
  ttsModel: 'kokoro',
  voice: 'af_bella',
  nativeSpeed: 1.3,
  language: 'en-US',
};

function deps(overrides: Partial<TtsVoicePreviewDeps> = {}) {
  const release = vi.fn(async () => undefined);
  const value = {
    resolveCredentials: vi.fn(async () => CREDS),
    synthesize: vi.fn(async () => Buffer.from('mp3-bytes')),
    acquireProviderCapacity: vi.fn(async () => release),
    synthesisTimeoutMs: 120_000,
    ...overrides,
  } satisfies TtsVoicePreviewDeps;
  return { deps: value, release };
}

describe('synthesizeTtsVoicePreview', () => {
  test('speaks the draft voice and speed with broker credentials and frees the provider slot', async () => {
    const { deps: d, release } = deps();
    const audio = await synthesizeTtsVoicePreview({ settings: SETTINGS, text: '  Hello there.  ' }, d);

    expect(audio.toString()).toBe('mp3-bytes');
    expect(d.resolveCredentials).toHaveBeenCalledWith('kokoro-shared', {});
    expect(d.acquireProviderCapacity).toHaveBeenCalledWith(expect.objectContaining({
      providerRef: 'kokoro-shared',
      characters: 'Hello there.'.length,
    }));
    expect(d.synthesize).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Hello there.',
      voice: 'af_bella',
      speed: 1.3,
      format: 'mp3',
      provider: 'custom-openai',
      apiKey: API_KEY,
      baseUrl: 'http://kokoro.internal/v1',
    }), expect.any(AbortSignal), { ttsUpstreamTimeoutMs: 30_000 });
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('rejects text longer than one preview sentence before resolving credentials', async () => {
    const { deps: d } = deps();
    await expect(synthesizeTtsVoicePreview({ settings: SETTINGS, text: 'x'.repeat(301) }, d))
      .rejects.toThrow('too long');
    expect(d.resolveCredentials).not.toHaveBeenCalled();
  });

  test('refuses oversized audio and still releases the provider slot', async () => {
    const { deps: d, release } = deps({
      synthesize: vi.fn(async () => Buffer.alloc(TTS_VOICE_PREVIEW_MAX_AUDIO_BYTES + 1)),
    });
    await expect(synthesizeTtsVoicePreview({ settings: SETTINGS, text: 'Hi.' }, d))
      .rejects.toBeInstanceOf(TtsVoicePreviewTooLargeError);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('aborts the provider call when the caller cancels the preview', async () => {
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const { deps: d, release } = deps({
      synthesize: vi.fn((_request, signal?: AbortSignal) => new Promise<Buffer>((_resolve, reject) => {
        providerSignal = signal;
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      })),
    });
    const pending = synthesizeTtsVoicePreview({ settings: SETTINGS, text: 'Hi.' }, d, controller.signal);
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    controller.abort(new Error('superseded'));
    await expect(pending).rejects.toThrow('superseded');
    expect(providerSignal?.aborted).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('voice preview route', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function appWith(d: TtsVoicePreviewDeps) {
    const logs: unknown[] = [];
    const app = Fastify();
    apps.push(app);
    const log = { info: (entry: unknown) => logs.push(entry), warn: (entry: unknown) => logs.push(entry) };
    registerVoicePreviewRoutes({
      app: Object.assign(app, { log: { ...app.log, ...log } }),
      ttsVoicePreview: d,
    } as unknown as ComputeWorkerRouteContext);
    return { app, logs };
  }

  test('returns uncached MP3 audio for a valid preview', async () => {
    const { app } = appWith(deps().deps);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tts-playback/voice-previews',
      payload: { settings: SETTINGS, text: 'Hello.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('audio/mpeg');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toBe('mp3-bytes');
  });

  test('rejects bad speeds, missing voices, and oversized text', async () => {
    const { app } = appWith(deps().deps);
    for (const payload of [
      { settings: { ...SETTINGS, nativeSpeed: 9 }, text: 'Hi.' },
      { settings: { ...SETTINGS, voice: '' }, text: 'Hi.' },
      { settings: { ...SETTINGS, providerType: 'not-a-provider' }, text: 'Hi.' },
      { settings: SETTINGS, text: 'x'.repeat(301) },
      { settings: SETTINGS, text: '   ' },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/v1/tts-playback/voice-previews', payload });
      expect(response.statusCode).toBe(400);
    }
  });

  test('never forwards caller-supplied credentials to the provider', async () => {
    const { deps: d } = deps();
    const { app } = appWith(d);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tts-playback/voice-previews',
      payload: { settings: { ...SETTINGS, apiKey: 'injected', baseUrl: 'http://evil' }, text: 'Hi.' },
    });
    expect(response.statusCode).toBe(200);
    expect(d.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: API_KEY, baseUrl: 'http://kokoro.internal/v1' }),
      expect.any(AbortSignal),
      expect.anything(),
    );
  });

  test('reports provider failures by code without leaking credentials', async () => {
    const { app, logs } = appWith(deps({
      resolveCredentials: vi.fn(async () => {
        throw new TtsCredentialBrokerClientError('PROVIDER_UNAVAILABLE', false);
      }),
    }).deps);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tts-playback/voice-previews',
      payload: { settings: SETTINGS, text: 'Hello.' },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'TTS provider is unavailable', code: 'PROVIDER_UNAVAILABLE' });
    expect(JSON.stringify(logs)).not.toContain(API_KEY);
    expect(JSON.stringify(logs)).not.toContain('Hello.');
  });

  test('maps an upstream rejection to a generic error', async () => {
    const upstream = Object.assign(new Error(`bad key ${API_KEY}`), { status: 401 });
    const { app } = appWith(deps({ synthesize: vi.fn(async () => { throw upstream; }) }).deps);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tts-playback/voice-previews',
      payload: { settings: SETTINGS, text: 'Hello.' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain(API_KEY);
  });
});

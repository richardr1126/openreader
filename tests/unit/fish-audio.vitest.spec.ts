import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildTTSCacheKey, generateTTSBuffer } from '@openreader/tts/generate';
import { FISH_AUDIO_VOICES, getDefaultVoices, providerSupportsCustomModel, resolveProviderModels } from '@openreader/tts/provider-catalog';
import { resolveProviderDefaults } from '@openreader/tts/provider-policy';
import { parseTtsCredentialBrokerResponse } from '@openreader/tts/credential-broker';
import { EXTERNAL_PROVIDER_ORDER } from '../../src/components/providers/provider-brands';
import { runProviderCheck } from '../../src/lib/server/admin/provider-check';

vi.mock('@openreader/tts/audio-format', () => ({
  normalizeToMp3: vi.fn(async (audio: Buffer) => audio),
  appendCbrSilence: vi.fn(async (audio: Buffer) => audio),
}));

const request = { provider: 'fish-audio', apiKey: 'test-secret', text: 'Fish request test', voice: 'default', speed: 1 };
afterEach(() => vi.unstubAllGlobals());

describe('Fish Audio', () => {
  test('uses the free model explicitly and supports broker resolution', () => {
    expect(EXTERNAL_PROVIDER_ORDER).toEqual(['openrouter', 'fish-audio', 'openai', 'replicate', 'deepinfra', 'custom-openai']);
    expect(resolveProviderDefaults({ providerRef: 'fish-audio' })).toMatchObject({
      providerType: 'fish-audio', defaultModel: 's2.1-pro-free', defaultVoice: FISH_AUDIO_VOICES[0].id,
    });
    expect(providerSupportsCustomModel('fish-audio')).toBe(false);
    for (const { id } of resolveProviderModels('fish-audio')) {
      expect(getDefaultVoices('fish-audio', id)).toEqual([...FISH_AUDIO_VOICES.map(({ id }) => id), 'default']);
    }
    expect(getDefaultVoices('fish-audio', 's1')).toEqual([]);
    expect(parseTtsCredentialBrokerResponse({ providerRef: 'my-fish', providerType: 'fish-audio',
      apiKey: 'test-secret', baseUrl: null, defaultModel: 's2.1-pro-free', defaultInstructions: null,
    })?.providerType).toBe('fish-audio');
  });

  test.each(resolveProviderModels('fish-audio').map(({ id }) => id))('sends %s as a header with an optional reference ID', async (model) => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateTTSBuffer({ ...request, model, voice: 'reference-123', speed: 1.2, language: 'en',
      baseUrl: 'https://untrusted.example', instructions: '  [Warm narration]\nwith care  ',
    })).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.fish.audio/v1/tts');
    expect(init.headers).toEqual({ Authorization: 'Bearer test-secret', 'Content-Type': 'application/json', model });
    expect(JSON.parse(init.body as string)).toEqual({ text: `[Warm narration with care] ${request.text}`, format: 'mp3',
      reference_id: 'reference-123', prosody: { speed: 1.2 }, language: 'en' });
    expect(init.redirect).toBe('error');
  });

  test('omits the default voice reference and clamps native speed', async () => {
    const fetchMock = vi.fn(async () => new Response('account text test-secret', { status: 402 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateTTSBuffer({ ...request, text: 'default voice', speed: 3 })).rejects.toMatchObject({
      status: 402, message: 'Fish Audio returned HTTP 402',
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ text: 'default voice', format: 'mp3', prosody: { speed: 2 } });
    expect((init.headers as Record<string, string>).model).toBe('s2.1-pro-free');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test('rejects unknown models and missing keys without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateTTSBuffer({ ...request, model: 'typo-paid-fallback' })).rejects.toMatchObject({ status: 422 });
    await expect(generateTTSBuffer({ ...request, model: 's1' })).rejects.toMatchObject({ status: 422 });
    await expect(generateTTSBuffer({ ...request, apiKey: '' })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('retries temporary failures and retains the selected model', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([4])));
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateTTSBuffer({ ...request, text: 'retry request' }, undefined, { ttsUpstreamMaxRetries: 1 }))
      .resolves.toEqual(Buffer.from([4]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1].headers.model).toBe('s2.1-pro-free');
  });

  test('propagates rate limits without exposing upstream text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('test-secret echoed', { status: 429, headers: { 'Retry-After': '0.01' } })));
    await expect(generateTTSBuffer({ ...request, text: 'throttled' }, undefined, { ttsUpstreamMaxRetries: 1 }))
      .rejects.toMatchObject({ status: 429, message: 'Fish Audio returned HTTP 429',
        response: { headers: expect.any(Headers) } });
  });

  test('cancels an active request', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })));
    const controller = new AbortController();
    const pending = generateTTSBuffer({ ...request, text: 'cancel request' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('bounds streamed audio and cancels an oversized response', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); },
      cancel,
    }))));
    await expect(generateTTSBuffer({ ...request, text: 'oversized response' })).rejects.toThrow('audio size limit');
    expect(cancel).toHaveBeenCalledOnce();
  });

  test('separates cached models and voice references', () => {
    expect(new Set(FISH_AUDIO_VOICES.map(({ id }) => buildTTSCacheKey({ ...request, voice: id }))).size).toBe(5);
    expect(buildTTSCacheKey({ ...request, model: 's2.1-pro-free' })).not.toBe(buildTTSCacheKey({ ...request, model: 's2.1-pro' }));
    expect(buildTTSCacheKey(request)).not.toBe(buildTTSCacheKey({ ...request, voice: 'reference-123' }));
    expect(buildTTSCacheKey(request)).not.toBe(buildTTSCacheKey({ ...request, instructions: 'Warm narration' }));
  });

  test('checks credentials against Fish voice metadata, then speaks through the worker', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}'));
    const preview = vi.fn<import('../../src/lib/server/admin/provider-check').ProviderCheckDeps['synthesizePreview']>(async () => ({ ok: true as const, audio: new ArrayBuffer(1024) }));
    const results = await runProviderCheck({ providerType: 'fish-audio', apiKey: 'test-secret', baseUrl: '',
      defaultModel: 's2.1-pro-free', defaultInstructions: '',
    }, { slug: 'my-fish', enabled: true, matchesDraft: true }, {
      fetch: fetchMock as typeof fetch, resolveVoices: async () => FISH_AUDIO_VOICES.map(({ id }) => id), workerAvailable: () => true,
      synthesizePreview: preview,
    }, new AbortController().signal);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.fish.audio/model?page_size=1');
    expect(preview.mock.calls[0][0]).toMatchObject({ settings: { providerRef: 'my-fish', providerType: 'fish-audio', voice: FISH_AUDIO_VOICES[0].id } });
    expect(results.every(({ status }) => status === 'ok')).toBe(true);
    expect(JSON.stringify(results)).not.toContain('test-secret');
  });
});

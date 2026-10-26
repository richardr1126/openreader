import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildTTSCacheKey, generateTTSBuffer } from '@openreader/tts/generate';
import { googleSpeechAudio } from '@openreader/tts/google-ai-studio';
import { pcmToWav } from '@openreader/tts/openrouter';
import { getDefaultVoices, isBuiltInTtsProviderId, resolveProviderModels } from '@openreader/tts/provider-catalog';
import { resolveTtsProviderModelPolicy } from '@openreader/tts/provider-policy';
import { parseTtsCredentialBrokerResponse } from '@openreader/tts/credential-broker';

vi.mock('@openreader/tts/audio-format', () => ({
  normalizeToMp3: vi.fn(async (audio: Buffer) => audio), appendCbrSilence: vi.fn(async (audio: Buffer) => audio),
}));
afterEach(() => vi.unstubAllGlobals());
const request = { provider: 'google-ai-studio', apiKey: 'synthetic-google-secret', text: 'A Google narration sample.', voice: 'Zephyr', speed: 1 };
const wav = Buffer.from(pcmToWav(new Uint8Array([1, 2, 3, 4])));
const payload = { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: wav.toString('base64') }] }] };

describe('Google AI Studio speech', () => {
  test('offers current speech models, voices and controls through the broker', () => {
    expect(isBuiltInTtsProviderId('deepinfra')).toBe(false);
    for (const { id: model } of resolveProviderModels('google-ai-studio')) {
      expect(getDefaultVoices('google-ai-studio', model)).toHaveLength(30);
      expect(resolveTtsProviderModelPolicy({ providerRef: 'google-ai-studio', model })).toMatchObject({ supportsNativeModelSpeed: false, supportsInstructions: true, supportsCustomModel: false });
    }
    expect(parseTtsCredentialBrokerResponse({ providerRef: 'my-google', providerType: 'google-ai-studio', apiKey: 'k', baseUrl: null, defaultModel: 'gemini-3.8-flash-tts', defaultInstructions: null })?.providerType).toBe('google-ai-studio');
  });

  test.each(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'])('sends %s with separate style metadata and decodes REST WAV', async model => {
    const fetchMock = vi.fn(async () => Response.json(payload)); vi.stubGlobal('fetch', fetchMock);
    await expect(generateTTSBuffer({ ...request, text: `Sample for ${model}`, model, instructions: 'Warm narration', speed: 2, baseUrl: 'https://wrong.example' })).resolves.toEqual(wav);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({ 'x-goog-api-key': request.apiKey, 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({ model,
      input: [{ type: 'user_input', content: [{ type: 'text', text: `Sample for ${model}`, annotations: [{ type: 'speech_metadata', style: 'Warm narration' }] }] }],
      response_format: { type: 'audio', mime_type: 'audio/wav', sample_rate: 24000 }, generation_config: { speech_config: [{ voice: 'Zephyr' }] }, store: false });
  });

  test('rejects removed providers and text models before network access', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    for (const input of [{ ...request, provider: 'deepinfra' }, { ...request, model: 'gemini-flash-latest' }]) {
      await expect(generateTTSBuffer(input)).rejects.toMatchObject({ status: 422 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('keeps voice and Instructions in identity while ignoring unsupported native speed', () => {
    expect(buildTTSCacheKey(request)).toBe(buildTTSCacheKey({ ...request, speed: 2 }));
    expect(buildTTSCacheKey(request)).not.toBe(buildTTSCacheKey({ ...request, voice: 'Kore' }));
    expect(buildTTSCacheKey(request)).not.toBe(buildTTSCacheKey({ ...request, instructions: 'Warm' }));
  });

  test('rejects incomplete, invalid or non-audio responses', () => {
    for (const body of [{}, { ...payload, status: 'failed' }, { status: 'completed', output_audio: { data: wav.toString('base64') } },
      { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: 'invalid' }] }] }]) {
      expect(() => googleSpeechAudio(body)).toThrow('Google AI Studio');
    }
  });

  test('does not echo upstream bodies or silently change models', async () => {
    const fetchMock = vi.fn(async () => new Response('synthetic-google-secret echoed', { status: 403 })); vi.stubGlobal('fetch', fetchMock);
    await expect(generateTTSBuffer({ ...request, text: 'Rejected Google sample' })).rejects.toMatchObject({ status: 403, message: 'Google AI Studio rejected the API key. Check it in provider settings.' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test('reports Google\'s HTTP 400 invalid-key reason as a rejected key without echoing the body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 400, message: 'API key not valid synthetic-google-secret',
      details: [{ reason: 'API_KEY_INVALID' }] } }, { status: 400 })));
    const error = await generateTTSBuffer({ ...request, text: 'Bad key sample' }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 401, message: 'Google AI Studio rejected the API key. Check it in provider settings.' });
    expect(String((error as Error).message)).not.toContain('synthetic-google-secret');
  });

  test('retries throttling with the same model and stops a retry wait on cancellation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0.001' } }))
      .mockImplementation(async () => Response.json(payload));
    vi.stubGlobal('fetch', fetchMock);
    await generateTTSBuffer({ ...request, text: 'Throttle recovery' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      queueMicrotask(() => controller.abort());
      return new Response('', { status: 429, headers: { 'Retry-After': '30' } });
    });
    await expect(generateTTSBuffer({ ...request, text: 'Cancel Google retry' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(generateTTSBuffer({ ...request, text: 'Already cancelled' }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('bounds response reads and splits long passages without changing custom voice IDs', async () => {
    const fetchMock = vi.fn(async () => Response.json(payload)); vi.stubGlobal('fetch', fetchMock);
    const text = 'Long narration sentence. '.repeat(90);
    await generateTTSBuffer({ ...request, text, voice: 'voicekey_example+custom' });
    const bodies = fetchMock.mock.calls.map(call => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)));
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.map(body => body.input[0].content[0].text).join('')).toBe(text);
    expect(bodies.every(body => body.input[0].content[0].text.length <= 1000 && body.generation_config.speech_config[0].voice === 'voicekey_example+custom')).toBe(true);
    fetchMock.mockImplementation(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(46 * 1024 * 1024)); controller.close();
    } })));
    await expect(generateTTSBuffer({ ...request, text: 'Oversized Google response' })).rejects.toThrow('size limit');
  });
});

import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildTTSCacheKey, generateTTSBuffer } from '@openreader/tts/generate';
import { buildTtsSegmentSettingsHash } from '@openreader/tts/segments';
import { FISH_AUDIO_VOICES, getDefaultVoices, resolveProviderModels } from '@openreader/tts/provider-catalog';
import { resolveTtsProviderModelPolicy } from '@openreader/tts/provider-policy';
import { OPENROUTER_DEFAULT_MODEL, normalizeOpenRouterOptions, openRouterCapabilities, parseOpenRouterModels, pcmToWav } from '@openreader/tts/openrouter';
import { parseTtsSegmentSettings } from '../../src/lib/server/tts/playback-request';

vi.mock('@openreader/tts/audio-format', () => ({
  normalizeToMp3: vi.fn(async (audio: Buffer) => audio), appendCbrSilence: vi.fn(async (audio: Buffer) => audio),
}));
afterEach(() => vi.unstubAllGlobals());
const request = { provider: 'openrouter', apiKey: 'synthetic-secret', text: 'A short speech sample.', voice: FISH_AUDIO_VOICES[0].id, speed: 1 };
const settings = { providerRef: 'router-instance', providerType: 'openrouter' as const, ttsModel: OPENROUTER_DEFAULT_MODEL, voice: request.voice, nativeSpeed: 1 };

describe('OpenRouter speech', () => {
  test('discovers all speech models and retains variant IDs and missing voice metadata', () => {
    const models = parseOpenRouterModels({ data: [
      { id: OPENROUTER_DEFAULT_MODEL, name: 'Free Fish', architecture: { output_modalities: ['speech'] }, supported_voices: null },
      { id: 'new/speech', name: 'New model', architecture: { output_modalities: ['speech'] }, supported_voices: ['new-voice'] },
      { id: 'text/model', name: 'Text', architecture: { output_modalities: ['text'] } },
    ] });
    expect(models).toHaveLength(2);
    expect(resolveProviderModels('openrouter', { openRouterModels: models }).map(m => m.id)).toEqual([OPENROUTER_DEFAULT_MODEL, 'new/speech', 'custom']);
    expect(getDefaultVoices('openrouter', OPENROUTER_DEFAULT_MODEL)).toEqual([...FISH_AUDIO_VOICES.map(v => v.id), 'default']);
    expect(getDefaultVoices('openrouter', 'new/speech')).toEqual([]);
    expect(getDefaultVoices('openrouter', 'bytedance-seed/seed-audio-1-0')).toEqual(['default']);
  });

  test.each([
    ['fish-audio/s1', true, true, 'mp3'], ['fish-audio/drama-3', true, true, 'mp3'],
    ['fish-audio/s2-pro', true, true, 'mp3'], [OPENROUTER_DEFAULT_MODEL, true, true, 'mp3'],
    ['fish-audio/s2.1-pro', true, true, 'mp3'], ['openai/gpt-4o-mini-tts-2025-12-15', true, true, 'mp3'],
    ['google/gemini-3.8-flash-lite-tts', true, false, 'pcm'], ['google/gemini-3.1-flash-tts-preview', true, false, 'pcm'],
    ['heygen/heygen-voice-1', false, false, 'pcm'], ['elevenlabs/eleven-v4', false, false, 'mp3'],
    ['microsoft/mai-voice-2.1', false, false, 'mp3'], ['deepgram/flux-tts', false, false, 'mp3'],
    ['qwen/qwen-audio-3.0-tts-plus', false, false, 'mp3'], ['minimax/speech-2.8-hd', false, false, 'mp3'],
    ['x-ai/grok-voice-tts-1.0', false, false, 'mp3'], ['canopylabs/orpheus-3b-0.1-ft', false, false, 'mp3'],
    ['sesame/csm-1b', false, false, 'mp3'], ['hexgrad/kokoro-82m', false, false, 'mp3'],
    ['mistralai/voxtral-mini-tts-3-0', false, false, 'mp3'], ['bytedance-seed/seed-audio-1-0', false, true, 'mp3'],
  ])('resolves %s controls and wire format', (model, instructions, speed, format) => {
    const p = resolveTtsProviderModelPolicy({ providerRef: 'router', providerType: 'openrouter', model: String(model) });
    expect(p.supportsInstructions).toBe(instructions); expect(p.supportsNativeModelSpeed).toBe(speed);
    expect(p.isKokoroModel).toBe(false); expect(openRouterCapabilities(String(model)).format).toBe(format);
  });

  test('sends Fish instructions once through OpenRouter, options nested by slug and no endpoint override', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2]))); vi.stubGlobal('fetch', fetchMock);
    await generateTTSBuffer({ ...request, text: 'Wire options sample', instructions: 'Warm narration', baseUrl: 'https://wrong.example',
      modelOptions: '{"provider":{"options":{"fish-audio":{"temperature":0.7}}}}' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/audio/speech'); expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toEqual({ model: OPENROUTER_DEFAULT_MODEL, input: 'Wire options sample', voice: request.voice,
      instructions: 'Warm narration', speed: 1, response_format: 'mp3', provider: { options: { 'fish-audio': { temperature: 0.7 } } } });
  });

  test('omits hidden instructions, unsupported speed and Automatic voice and wraps PCM', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2]))); vi.stubGlobal('fetch', fetchMock);
    await expect(generateTTSBuffer({ ...request, model: 'heygen/heygen-voice-1', text: 'PCM sample', voice: 'nadine', instructions: 'ignored', speed: 2 }))
      .resolves.toEqual(Buffer.from(pcmToWav(new Uint8Array([1, 2]))));
    let body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).not.toHaveProperty('instructions'); expect(body).not.toHaveProperty('speed'); expect(body.response_format).toBe('pcm');
    await generateTTSBuffer({ ...request, text: 'Automatic sample', voice: 'default' });
    body = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)); expect(body).not.toHaveProperty('voice');
    expect(() => pcmToWav(new Uint8Array([1]))).toThrow('invalid PCM');
  });

  test('canonical options participate in playback and upstream cache identity and survive request parsing', () => {
    const a = normalizeOpenRouterOptions('{"provider":{"options":{"fish-audio":{"top_p":0.5,"temperature":0.7}}}}', OPENROUTER_DEFAULT_MODEL);
    const b = normalizeOpenRouterOptions('{"provider":{"options":{"fish-audio":{"temperature":0.7,"top_p":0.5}}}}', OPENROUTER_DEFAULT_MODEL);
    expect(a).toBe(b);
    expect(buildTTSCacheKey({ ...request, modelOptions: a })).toBe(buildTTSCacheKey({ ...request, modelOptions: b }));
    expect(buildTTSCacheKey({ ...request, modelOptions: a })).not.toBe(buildTTSCacheKey(request));
    expect(buildTtsSegmentSettingsHash({ ...settings, ttsModelOptions: a })).not.toBe(buildTtsSegmentSettingsHash(settings));
    expect(parseTtsSegmentSettings({ ...settings, ttsModelOptions: a })?.ttsModelOptions).toBe(a);
    expect(normalizeOpenRouterOptions(a, 'other/model')).toBe('');
    expect(() => normalizeOpenRouterOptions('{"provider":{"options":{"fish-audio":{"api_key":"bad"}}}}', OPENROUTER_DEFAULT_MODEL)).toThrow('Credentials');
    expect(() => normalizeOpenRouterOptions('{"input_references":[{"type":"input_audio","input_audio":{"url":"http://localhost/x"}}]}', OPENROUTER_DEFAULT_MODEL)).toThrow('HTTPS');
  });

  test('propagates upstream failure without echoing secrets or switching models', async () => {
    const fetchMock = vi.fn(async () => new Response('synthetic-secret upstream echo', { status: 402 })); vi.stubGlobal('fetch', fetchMock);
    await expect(generateTTSBuffer({ ...request, text: 'Rejected speech' })).rejects.toMatchObject({ status: 402, message: 'OpenRouter returned HTTP 402' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

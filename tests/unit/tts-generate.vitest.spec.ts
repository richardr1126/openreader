import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  buildReplicateInput,
  buildTTSCacheKey,
  extractReplicateAudioUrl,
  generateTTSBuffer,
  registerLocalTtsSynthesizer,
  resolveReplicateLanguageValue,
} from '@openreader/tts/generate';
import { REPLICATE_KOKORO_82M_VERSIONED_MODEL } from '@openreader/tts/provider-catalog';

describe('replicate output URL extraction', () => {
  test('returns direct URL string output', () => {
    expect(extractReplicateAudioUrl('https://replicate.delivery/audio.mp3')).toBe(
      'https://replicate.delivery/audio.mp3'
    );
  });

  test('extracts URL from FileOutput-like objects', () => {
    const output = {
      url: () => new URL('https://replicate.delivery/file.wav'),
    };
    expect(extractReplicateAudioUrl(output)).toBe('https://replicate.delivery/file.wav');
  });

  test('extracts first URL from array outputs', () => {
    const output: unknown[] = [
      { value: 'not-a-url' },
      { toString: () => 'https://replicate.delivery/chunk-0.mp3' },
      'https://replicate.delivery/chunk-1.mp3',
    ];
    expect(extractReplicateAudioUrl(output)).toBe('https://replicate.delivery/chunk-0.mp3');
  });

  test('extracts nested URL from object outputs', () => {
    const output = {
      output: {
        audio: {
          url: 'https://replicate.delivery/nested.mp3',
        },
      },
    };
    expect(extractReplicateAudioUrl(output)).toBe('https://replicate.delivery/nested.mp3');
  });

  test('returns null for non-url outputs', () => {
    const output = { status: 'ok', value: 123 };
    expect(extractReplicateAudioUrl(output)).toBeNull();
  });

  test('allows replicate.delivery subdomains', () => {
    expect(extractReplicateAudioUrl('https://pbxt.replicate.delivery/out-0.wav')).toBe(
      'https://pbxt.replicate.delivery/out-0.wav'
    );
  });

  test('rejects URLs from non-replicate hosts (SSRF guard)', () => {
    expect(extractReplicateAudioUrl('http://169.254.169.254/latest/meta-data/')).toBeNull();
    expect(extractReplicateAudioUrl('https://evil.example.com/audio.mp3')).toBeNull();
    // a host that merely embeds the allowed host as a substring must not pass
    expect(extractReplicateAudioUrl('https://replicate.delivery.evil.com/x.mp3')).toBeNull();
    expect(extractReplicateAudioUrl({ url: () => new URL('http://localhost:6379/') })).toBeNull();
  });
});

describe('TTS upstream cache identity', () => {
  test('includes language in the upstream audio cache key', () => {
    const request = {
      text: '同じ文章です。',
      voice: 'jf_alpha',
      speed: 1,
      format: 'mp3',
      model: 'kokoro',
      provider: 'custom-openai',
      apiKey: 'test',
    };

    expect(buildTTSCacheKey({ ...request, language: 'ja' }))
      .not.toBe(buildTTSCacheKey({ ...request, language: 'en' }));
  });
});

describe('Replicate language schema values', () => {
  test('uses language codes or advertised display names without a model table', () => {
    expect(resolveReplicateLanguageValue('ja-JP', [])).toBe('ja-JP');
    expect(resolveReplicateLanguageValue('ja-JP', ['en', 'ja', 'zh'])).toBe('ja');
    expect(resolveReplicateLanguageValue('ja-JP', ['English', 'Japanese'])).toBe('Japanese');
    expect(resolveReplicateLanguageValue('ja-JP', ['English', 'French'])).toBeNull();
  });

  test('expands a bare language to its likely region for region-only enums', () => {
    const gemini = ['en-AU', 'en-GB', 'en-US', 'ja-JP', 'pt-BR', 'pt-PT'];
    expect(resolveReplicateLanguageValue('en', gemini)).toBe('en-US');
    expect(resolveReplicateLanguageValue('en-GB', gemini)).toBe('en-GB');
    expect(resolveReplicateLanguageValue('ja', gemini)).toBe('ja-JP');
    expect(resolveReplicateLanguageValue('pt', gemini)).toBe('pt-BR');
    expect(resolveReplicateLanguageValue('fr', gemini)).toBeNull();
  });

  test('includes language_code for the built-in Replicate Kokoro model', async () => {
    await expect(buildReplicateInput({
      text: 'Hello world',
      voice: 'af_sarah',
      speed: 1,
      format: 'mp3',
      model: REPLICATE_KOKORO_82M_VERSIONED_MODEL,
      language: 'en',
      provider: 'replicate',
      apiKey: 'r8_token',
    })).resolves.toEqual({
      text: 'Hello world',
      voice: 'af_sarah',
      language_code: 'a',
    });

    await expect(buildReplicateInput({
      text: 'Hello world',
      voice: 'bf_emma',
      speed: 1,
      format: 'mp3',
      model: REPLICATE_KOKORO_82M_VERSIONED_MODEL,
      language: 'en',
      provider: 'replicate',
      apiKey: 'r8_token',
    })).resolves.toEqual({
      text: 'Hello world',
      voice: 'bf_emma',
      language_code: 'b',
    });

    await expect(buildReplicateInput({
      text: 'Hello world',
      voice: 'af_sarah',
      speed: 1,
      format: 'mp3',
      model: REPLICATE_KOKORO_82M_VERSIONED_MODEL,
      provider: 'replicate',
      apiKey: 'r8_token',
    })).resolves.toEqual({
      text: 'Hello world',
      voice: 'af_sarah',
      language_code: 'a',
    });
  });
});

describe('speech-sdk request resolution', () => {
  test('rejects unknown provider prefixes before any network call', async () => {
    await expect(generateTTSBuffer({
      text: 'hello',
      voice: 'alloy',
      speed: 1,
      model: 'doesnotexist/some-model',
      provider: 'speech-sdk',
      apiKey: 'unused',
    })).rejects.toThrow('Unknown Speech SDK provider prefix');
  });

  test('rejects models missing the provider/model form', async () => {
    for (const model of ['openai', 'openai/', '/gpt-4o-mini-tts']) {
      await expect(generateTTSBuffer({
        text: 'hello',
        voice: 'alloy',
        speed: 1,
        model,
        provider: 'speech-sdk',
        apiKey: 'unused',
      })).rejects.toThrow('Expected "provider/model"');
    }
  });
});

describe('OpenAI-compatible base URL', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('sends a Deepinfra provider without a stored base URL to Deepinfra', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => new Response(
      JSON.stringify({ error: { message: 'stop after the request' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateTTSBuffer({
      text: 'deepinfra base url check',
      voice: 'af_bella',
      speed: 1,
      model: 'hexgrad/Kokoro-82M',
      provider: 'deepinfra',
      apiKey: 'test-key',
    })).rejects.toThrow();

    const [input] = fetchMock.mock.calls[0];
    const url = input instanceof Request ? input.url : String(input);
    expect(url).toBe('https://api.deepinfra.com/v1/openai/audio/speech');
  });
});

describe('local Kokoro provider', () => {
  afterEach(() => {
    registerLocalTtsSynthesizer(null);
  });

  test('refuses to synthesize outside the compute worker', async () => {
    await expect(generateTTSBuffer({
      text: 'local kokoro without an engine',
      voice: 'af_heart',
      speed: 1,
      provider: 'kokoro-local',
      apiKey: '',
    })).rejects.toThrow(/only in the compute worker/);
  });

  test('hands the registered engine the text, the voice blend and the native speed', async () => {
    const synthesize = vi.fn(async () => {
      throw new Error('stop before transcoding');
    });
    registerLocalTtsSynthesizer(synthesize);

    await expect(generateTTSBuffer({
      text: 'local kokoro with an engine',
      voice: 'af_heart(0.7)+bf_emma(0.3)',
      speed: 1.25,
      model: 'gpt-4o-mini-tts',
      provider: 'kokoro-local',
      apiKey: '',
    })).rejects.toThrow('stop before transcoding');

    expect(synthesize).toHaveBeenCalledWith(
      { text: 'local kokoro with an engine', voice: 'af_heart(0.7)+bf_emma(0.3)', speed: 1.25 },
      expect.any(AbortSignal),
    );
  });
});

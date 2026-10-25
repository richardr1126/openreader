import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  buildReplicateInput,
  buildTTSCacheKey,
  extractReplicateAudioUrl,
  generateTTSBuffer,
  registerLocalTtsSynthesizer,
  resolveReplicateLanguageValue,
} from '@openreader/tts/generate';

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
  test('retains the released Inworld model identity for saved audio', () => {
    expect(buildTTSCacheKey({
      text: 'A saved Inworld passage.', voice: 'Ashley', speed: 1,
      provider: 'replicate', model: 'inworld/tts-1.5-mini', apiKey: 'test',
    })).toBe('a025f53b850fdfdd2f1f0dcb5f35eab1bef2cf93f6a5d353c3f52a0127a36f53');
  });
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

describe('renamed Replicate Inworld model', () => {
  afterEach(() => vi.unstubAllGlobals());

  test.each(['inworld/tts-1.5-mini', 'inworld/realtime-tts-1.5-mini'])(
    'executes %s through the current SDK endpoint with native rate and language', async (model) => {
      const calls: { url: string; body: Record<string, unknown> | null }[] = [];
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = request.method === 'POST' ? await request.json() : null;
        calls.push({ url: request.url, body });
        if (request.url.endsWith('/predictions')) {
          return new Response(JSON.stringify({ id: 'prediction1', status: 'succeeded',
            output: 'https://replicate.delivery/inworld-check.mp3' }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (request.url.startsWith('https://replicate.delivery/')) {
          // Stop after verifying SDK dispatch; no transcoding or real service.
          return new Response('', { status: 404 });
        }
        return new Response(JSON.stringify({ latest_version: { openapi_schema: {
          components: { schemas: { Input: { properties: { language: { enum: ['English', 'Spanish'] } } } } },
        } } }), { headers: { 'Content-Type': 'application/json' } });
      });
      await expect(generateTTSBuffer({ text: `Inworld endpoint check ${model}`, voice: 'Ashley', speed: 1.2,
        provider: 'replicate', model, language: 'es', apiKey: 'test-key' })).rejects.toThrow();
      const prediction = calls.find((call) => call.url.endsWith('/predictions'));
      expect(prediction?.url).toBe('https://api.replicate.com/v1/models/inworld/realtime-tts-1.5-mini/predictions');
      expect(prediction?.body?.input).toMatchObject({ voice_id: 'Ashley', speaking_rate: 1.2, language: 'Spanish' });
      expect(prediction?.body?.input).not.toHaveProperty('speed');
      expect(calls.every((call) => !call.url.includes('/inworld/tts-1.5-mini'))).toBe(true);
    },
  );
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

  test.each(['alphanumericuser/kokoro-82m', `alphanumericuser/kokoro-82m:${'a'.repeat(64)}`])('rejects retired model %s without fetching or replacing it', async (model) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const request = { text: 'Hello world', voice: 'af_sarah', speed: 1.2, format: 'mp3', model, provider: 'replicate', apiKey: 'mock-key' };
      const key = buildTTSCacheKey(request);
      await expect(generateTTSBuffer(request)).rejects.toMatchObject({ status: 422, message: expect.stringContaining('Choose another model') });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(request.model).toBe(model);
      expect(buildTTSCacheKey(request)).toBe(key);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('provider request text', () => {
  test('drops private-use glyphs such as Word symbol-font bullets', async () => {
    const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => new Response(
      JSON.stringify({ error: { message: 'stop after the request' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(generateTTSBuffer({
        text: '\tTables, lists and footnotes.',
        voice: 'af_bella',
        speed: 1,
        model: 'hexgrad/Kokoro-82M',
        provider: 'deepinfra',
        apiKey: 'test-key',
      })).rejects.toThrow();
      const [input, init] = fetchMock.mock.calls[0];
      const body = input instanceof Request ? await input.text() : String((init as RequestInit).body);
      expect(JSON.parse(body).input).toBe('\tTables, lists and footnotes.');
    } finally {
      vi.unstubAllGlobals();
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

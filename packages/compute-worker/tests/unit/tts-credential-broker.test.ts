import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  resolveTtsCredentialsFromBroker,
  TtsCredentialBrokerClientError,
} from '../../src/jobs/tts-credential-broker';
import { requireTtsSegmentTextHashSecret } from '../../src/infrastructure/credential-broker-config';

const BROKER_URL = 'https://openreader.example/api/internal/compute/tts-credentials';
const BROKER_TOKEN = 'worker-to-app-broker-token';
const previousEnv = {
  url: process.env.COMPUTE_CREDENTIAL_BROKER_URL,
  token: process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN,
  timeout: process.env.COMPUTE_CREDENTIAL_BROKER_TIMEOUT_MS,
  playback: process.env.TTS_PLAYBACK_TOKEN_SECRET,
};

describe('TTS credential broker client', () => {
  beforeEach(() => {
    process.env.COMPUTE_CREDENTIAL_BROKER_URL = BROKER_URL;
    process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN = BROKER_TOKEN;
    process.env.COMPUTE_CREDENTIAL_BROKER_TIMEOUT_MS = '1000';
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (previousEnv.url === undefined) delete process.env.COMPUTE_CREDENTIAL_BROKER_URL;
    else process.env.COMPUTE_CREDENTIAL_BROKER_URL = previousEnv.url;
    if (previousEnv.token === undefined) delete process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN;
    else process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN = previousEnv.token;
    if (previousEnv.timeout === undefined) delete process.env.COMPUTE_CREDENTIAL_BROKER_TIMEOUT_MS;
    else process.env.COMPUTE_CREDENTIAL_BROKER_TIMEOUT_MS = previousEnv.timeout;
    if (previousEnv.playback === undefined) delete process.env.TTS_PLAYBACK_TOKEN_SECRET;
    else process.env.TTS_PLAYBACK_TOKEN_SECRET = previousEnv.playback;
  });

  test('sends only the provider reference and broker authorization', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      providerRef: 'kokoro',
      providerType: 'custom-openai',
      apiKey: 'credential-sentinel',
      baseUrl: 'http://kokoro:8880/v1',
      defaultModel: 'kokoro',
      defaultInstructions: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveTtsCredentialsFromBroker('kokoro')).resolves.toEqual({
      providerRef: 'kokoro',
      providerType: 'custom-openai',
      apiKey: 'credential-sentinel',
      baseUrl: 'http://kokoro:8880/v1',
      defaultModel: 'kokoro',
      defaultInstructions: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(BROKER_URL);
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${BROKER_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({ providerRef: 'kokoro' });
    expect(String(init.body)).not.toContain('credential-sentinel');
  });

  test('retries a bounded broker-unavailable response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'BROKER_UNAVAILABLE' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        providerRef: 'kokoro',
        providerType: 'custom-openai',
        apiKey: '',
        baseUrl: 'http://kokoro:8880/v1',
        defaultModel: 'kokoro',
        defaultInstructions: null,
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveTtsCredentialsFromBroker('kokoro')).resolves.toMatchObject({ providerRef: 'kokoro' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('fails closed without retrying authentication or provider errors', async () => {
    const secret = 'must-not-appear-in-client-errors';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'BROKER_UNAUTHORIZED',
      detail: secret,
    }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await resolveTtsCredentialsFromBroker('kokoro').catch((caught) => caught);
    expect(error).toBeInstanceOf(TtsCredentialBrokerClientError);
    expect(error).toMatchObject({ code: 'BROKER_UNAUTHORIZED', retryable: false });
    expect(String(error)).not.toContain(secret);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('rejects malformed successful responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      providerRef: 'kokoro',
      providerType: 'custom-openai',
      apiKey: 123,
    }), { status: 200 })));

    await expect(resolveTtsCredentialsFromBroker('kokoro')).rejects.toMatchObject({
      code: 'BROKER_RESPONSE_INVALID',
      retryable: false,
    });
  });

  test('propagates caller cancellation without converting it to a retryable broker error', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })));
    const controller = new AbortController();
    const request = resolveTtsCredentialsFromBroker('kokoro', { signal: controller.signal });
    controller.abort(new Error('job cancelled'));

    await expect(request).rejects.toThrow('job cancelled');
  });

  test('applies the configured request timeout without leaking fetch details', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: URL, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('fetch-detail-must-not-leak')), { once: true });
    })));

    const request = resolveTtsCredentialsFromBroker('kokoro', { attempts: 1 })
      .catch((caught) => caught);
    await vi.advanceTimersByTimeAsync(1_000);

    const error = await request;
    expect(error).toMatchObject({ code: 'BROKER_REQUEST_TIMEOUT', retryable: true });
    expect(String(error)).not.toContain('fetch-detail-must-not-leak');
  });

  test('rejects missing configuration without making a request', async () => {
    delete process.env.COMPUTE_CREDENTIAL_BROKER_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveTtsCredentialsFromBroker('kokoro')).rejects.toMatchObject({
      code: 'BROKER_CONFIG_INVALID',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects insecure public or non-canonical broker URLs', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    process.env.COMPUTE_CREDENTIAL_BROKER_URL = 'http://openreader.example/api/internal/compute/tts-credentials';
    await expect(resolveTtsCredentialsFromBroker('kokoro')).rejects.toMatchObject({
      code: 'BROKER_CONFIG_INVALID',
      retryable: false,
    });

    process.env.COMPUTE_CREDENTIAL_BROKER_URL = 'https://openreader.example/api/not-the-broker';
    await expect(resolveTtsCredentialsFromBroker('kokoro')).rejects.toMatchObject({
      code: 'BROKER_CONFIG_INVALID',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('derives a stable domain-separated text fingerprint key from the playback secret', () => {
    process.env.TTS_PLAYBACK_TOKEN_SECRET = 'stable-playback-secret';
    const first = requireTtsSegmentTextHashSecret();
    const second = requireTtsSegmentTextHashSecret();
    process.env.TTS_PLAYBACK_TOKEN_SECRET = 'rotated-playback-secret';

    expect(first).toBe(second);
    expect(first).not.toBe('stable-playback-secret');
    expect(requireTtsSegmentTextHashSecret()).not.toBe(first);
  });
});

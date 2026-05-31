import OpenAI from 'openai';
import Replicate from 'replicate';
import { SpeechCreateParams } from 'openai/resources/audio/speech.mjs';
import {
  isBuiltInTtsProviderId,
  REPLICATE_KOKORO_82M_VERSIONED_MODEL,
} from '@/lib/shared/tts-provider-catalog';
import { resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';
import { resolveReplicateVoiceInputKey } from '@/lib/server/tts/voice-resolution';
import { getUpstreamRetryAfterSeconds, getUpstreamStatus } from '@/lib/server/tts/upstream-response';
import { LRUCache } from 'lru-cache';
import { createHash } from 'crypto';
import { access, readFile } from 'fs/promises';
import { resolve } from 'path';

export interface ServerTTSRequest {
  text: string;
  voice: string;
  speed: number;
  format?: string;
  model?: string | null;
  instructions?: string;
  provider: string;
  apiKey: string;
  baseUrl?: string;
  testNamespace?: string | null;
}

type CustomVoice = string;
type ExtendedSpeechParams = Omit<SpeechCreateParams, 'voice'> & {
  voice: SpeechCreateParams['voice'] | CustomVoice;
  instructions?: string;
};

type ResolvedServerTTSRequest = {
  text: string;
  voice: string;
  speed: number;
  format: string;
  model: SpeechCreateParams['model'];
  instructions?: string;
  provider: string;
  apiKey: string;
  baseUrl?: string;
  testNamespace?: string | null;
};

type InflightEntry = {
  promise: Promise<Buffer>;
  controller: AbortController;
  consumers: number;
};

const REPLICATE_COOLDOWN_SCOPE_CACHE_MAX_ENTRIES = 512;
const replicateBlockedUntilByScope = new LRUCache<string, number>({
  max: REPLICATE_COOLDOWN_SCOPE_CACHE_MAX_ENTRIES,
});

const DEFAULT_TTS_CACHE_MAX_SIZE_BYTES = 256 * 1024 * 1024;
const DEFAULT_TTS_CACHE_TTL_MS = 1000 * 60 * 30;
const DEFAULT_TTS_UPSTREAM_MAX_RETRIES = 2;
const DEFAULT_TTS_UPSTREAM_TIMEOUT_MS = 285_000;
const OPENAI_RETRY_INITIAL_DELAY_MS = 250;
const OPENAI_RETRY_MAX_DELAY_MS = 2000;
const OPENAI_RETRY_BACKOFF = 2;

export interface TtsUpstreamRuntimeSettings {
  ttsCacheMaxSizeBytes?: number;
  ttsCacheTtlMs?: number;
  ttsUpstreamMaxRetries?: number;
  ttsUpstreamTimeoutMs?: number;
}

interface ResolvedTtsUpstreamRuntimeSettings {
  ttsCacheMaxSizeBytes: number;
  ttsCacheTtlMs: number;
  ttsUpstreamMaxRetries: number;
  ttsUpstreamTimeoutMs: number;
}

function clampPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function resolveTtsUpstreamSettings(
  settings?: TtsUpstreamRuntimeSettings,
): ResolvedTtsUpstreamRuntimeSettings {
  return {
    ttsCacheMaxSizeBytes: clampPositiveInteger(
      settings?.ttsCacheMaxSizeBytes,
      DEFAULT_TTS_CACHE_MAX_SIZE_BYTES,
    ),
    ttsCacheTtlMs: clampPositiveInteger(settings?.ttsCacheTtlMs, DEFAULT_TTS_CACHE_TTL_MS),
    ttsUpstreamMaxRetries: clampPositiveInteger(
      settings?.ttsUpstreamMaxRetries,
      DEFAULT_TTS_UPSTREAM_MAX_RETRIES,
    ),
    ttsUpstreamTimeoutMs: clampPositiveInteger(
      settings?.ttsUpstreamTimeoutMs,
      DEFAULT_TTS_UPSTREAM_TIMEOUT_MS,
    ),
  };
}

function createTtsAudioCache(maxSize: number, ttlMs: number): LRUCache<string, Buffer> {
  return new LRUCache<string, Buffer>({
    maxSize,
    sizeCalculation: (value) => value.byteLength,
    ttl: ttlMs,
  });
}

let activeCacheConfig = {
  maxSize: DEFAULT_TTS_CACHE_MAX_SIZE_BYTES,
  ttlMs: DEFAULT_TTS_CACHE_TTL_MS,
};

let ttsAudioCache = createTtsAudioCache(activeCacheConfig.maxSize, activeCacheConfig.ttlMs);

function ensureTtsAudioCache(settings: ResolvedTtsUpstreamRuntimeSettings): void {
  if (
    activeCacheConfig.maxSize === settings.ttsCacheMaxSizeBytes
    && activeCacheConfig.ttlMs === settings.ttsCacheTtlMs
  ) {
    return;
  }

  activeCacheConfig = {
    maxSize: settings.ttsCacheMaxSizeBytes,
    ttlMs: settings.ttsCacheTtlMs,
  };
  ttsAudioCache = createTtsAudioCache(activeCacheConfig.maxSize, activeCacheConfig.ttlMs);
}

const inflightRequests = new Map<string, InflightEntry>();

const TEST_TTS_MOCK_PATH = resolve(process.cwd(), 'tests/files/sample.mp3');
let testMockTtsBufferPromise: Promise<Buffer | null> | null = null;

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function getReplicateCooldownScopeKey(request: ResolvedServerTTSRequest): string {
  return createHash('sha256')
    .update(`replicate:${request.apiKey}:${request.model as string}`)
    .digest('hex');
}

function applyReplicateCooldown(scopeKey: string, cooldownMs: number) {
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) return;
  const next = Date.now() + cooldownMs;
  const current = replicateBlockedUntilByScope.get(scopeKey) ?? 0;
  replicateBlockedUntilByScope.set(scopeKey, Math.max(current, next));
}

async function runWithReplicateGate<T>(
  scopeKey: string,
  signal: AbortSignal,
  operation: () => Promise<T>
): Promise<T> {
  const blockedUntilMs = replicateBlockedUntilByScope.get(scopeKey) ?? 0;
  const waitMs = Math.max(0, blockedUntilMs - Date.now());
  if (waitMs > 0) {
    await sleepWithSignal(waitMs, signal);
  }
  return operation();
}

function normalizeReplicateUrlCandidate(value: unknown): string | null {
  if (value instanceof URL) {
    return value.toString();
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('data:')) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

function extractReplicateAudioUrlFromValue(value: unknown, seen: Set<object>): string | null {
  const direct = normalizeReplicateUrlCandidate(value);
  if (direct) {
    return direct;
  }

  if (typeof value !== 'object' || value === null) {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractReplicateAudioUrlFromValue(item, seen);
      if (extracted) {
        return extracted;
      }
    }
    return null;
  }

  const maybeUrlMethod = (value as { url?: unknown }).url;
  if (typeof maybeUrlMethod === 'function') {
    try {
      const fromUrlMethod = normalizeReplicateUrlCandidate(maybeUrlMethod.call(value));
      if (fromUrlMethod) {
        return fromUrlMethod;
      }
    } catch { }
  } else {
    const fromUrlField = normalizeReplicateUrlCandidate(maybeUrlMethod);
    if (fromUrlField) {
      return fromUrlField;
    }
  }

  const maybeToString = (value as { toString?: unknown }).toString;
  if (typeof maybeToString === 'function') {
    try {
      const fromToString = normalizeReplicateUrlCandidate(maybeToString.call(value));
      if (fromToString) {
        return fromToString;
      }
    } catch { }
  }

  const record = value as Record<string, unknown>;
  for (const key of ['audio', 'output', 'outputs', 'file', 'files', 'data', 'result']) {
    if (!(key in record)) continue;
    const extracted = extractReplicateAudioUrlFromValue(record[key], seen);
    if (extracted) {
      return extracted;
    }
  }

  for (const nested of Object.values(record)) {
    const extracted = extractReplicateAudioUrlFromValue(nested, seen);
    if (extracted) {
      return extracted;
    }
  }

  return null;
}

export function extractReplicateAudioUrl(output: unknown): string | null {
  return extractReplicateAudioUrlFromValue(output, new Set<object>());
}

function resolveTTSRequest(input: ServerTTSRequest): ResolvedServerTTSRequest {
  const provider = input.provider || 'openai';
  const providerType = isBuiltInTtsProviderId(provider) ? provider : 'openai';
  const rawModel = provider === 'deepinfra' && !input.model ? 'hexgrad/Kokoro-82M'
    : provider === 'replicate' && !input.model ? REPLICATE_KOKORO_82M_VERSIONED_MODEL
    : input.model;
  const model = (rawModel ?? 'gpt-4o-mini-tts') as SpeechCreateParams['model'];
  const providerModelPolicy = resolveTtsProviderModelPolicy({
    providerRef: provider,
    providerType,
    model: model as string,
  });

  const normalizedVoice = (
    (providerType === 'replicate' || !providerModelPolicy.isKokoroModel) && input.voice.includes('+')
      ? input.voice.split('+')[0].trim()
      : input.voice
  ) as string;

  const format = input.format || 'mp3';
  const requestedSpeed = Number.isFinite(Number(input.speed)) ? Number(input.speed) : 1;
  const speed = providerModelPolicy.supportsNativeModelSpeed ? requestedSpeed : 1;
  const instructions = providerModelPolicy.supportsInstructions && input.instructions
    ? input.instructions
    : undefined;

  return {
    text: input.text,
    voice: normalizedVoice,
    speed,
    format,
    model,
    instructions,
    provider,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    testNamespace: input.testNamespace || null,
  };
}

function makeCacheKey(input: {
  provider: string;
  model: string | null | undefined;
  voice: string | undefined;
  speed: number;
  format: string;
  text: string;
  instructions?: string;
  testNamespace?: string | null;
}) {
  const canonical = {
    provider: input.provider,
    model: input.model || '',
    voice: input.voice || '',
    speed: input.speed,
    format: input.format,
    text: input.text,
    instructions: input.instructions || undefined,
    testNamespace: input.testNamespace || undefined,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function buildTTSCacheKey(request: ServerTTSRequest): string {
  const resolved = resolveTTSRequest(request);
  return makeCacheKey({
    provider: resolved.provider,
    model: resolved.model,
    voice: resolved.voice,
    speed: resolved.speed,
    format: resolved.format,
    text: resolved.text,
    instructions: resolved.instructions,
    testNamespace: resolved.testNamespace,
  });
}

export function getCachedTTSBuffer(cacheKey: string): Buffer | undefined {
  return ttsAudioCache.get(cacheKey);
}

export function getTTSContentType(format: string | undefined): string {
  return (format || 'mp3') === 'mp3' ? 'audio/mpeg' : 'application/octet-stream';
}

async function getTestMockTtsBuffer(testNamespace?: string | null): Promise<Buffer | null> {
  if (!testNamespace) return null;
  if (!testMockTtsBufferPromise) {
    testMockTtsBufferPromise = (async () => {
      try {
        await access(TEST_TTS_MOCK_PATH);
      } catch {
        return null;
      }
      return readFile(TEST_TTS_MOCK_PATH);
    })();
  }
  return testMockTtsBufferPromise;
}

async function fetchTTSBufferWithRetry(
  openai: OpenAI,
  createParams: ExtendedSpeechParams,
  signal: AbortSignal,
  maxRetries: number,
): Promise<Buffer> {
  let attempt = 0;
  let delay = OPENAI_RETRY_INITIAL_DELAY_MS;

  for (; ;) {
    try {
      const response = await openai.audio.speech.create(createParams as SpeechCreateParams, { signal });
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer);
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }

      const status = getUpstreamStatus(error) ?? 0;
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt >= maxRetries) {
        throw error;
      }

      await sleep(Math.min(delay, OPENAI_RETRY_MAX_DELAY_MS));
      delay = Math.min(OPENAI_RETRY_MAX_DELAY_MS, delay * OPENAI_RETRY_BACKOFF);
      attempt += 1;
    }
  }
}

async function buildReplicateInput(request: ResolvedServerTTSRequest): Promise<Record<string, unknown>> {
  const model = request.model as string;

  if (model === 'google/gemini-3.1-flash-tts') {
    const input: Record<string, unknown> = {
      text: request.text,
      voice: request.voice,
    };
    if (request.instructions) {
      input.prompt = request.instructions;
    }
    return input;
  }

  if (model === 'minimax/speech-2.8-turbo') {
    const input: Record<string, unknown> = {
      text: request.text,
      voice_id: request.voice,
      audio_format: request.format === 'mp3' ? 'mp3' : 'wav',
    };
    if (request.speed !== 1) {
      input.speed = Math.max(0.5, Math.min(2.0, request.speed));
    }
    return input;
  }

  if (model === 'qwen/qwen3-tts') {
    const input: Record<string, unknown> = {
      text: request.text,
      mode: 'custom_voice',
      speaker: request.voice,
    };
    if (request.instructions) {
      input.style_instruction = request.instructions;
    }
    return input;
  }

  if (model === 'inworld/tts-1.5-mini') {
    const input: Record<string, unknown> = {
      text: request.text,
      voice_id: request.voice,
      audio_format: request.format === 'mp3' ? 'mp3' : 'wav',
    };
    if (request.speed !== 1) {
      input.speaking_rate = request.speed;
    }
    return input;
  }

  const input: Record<string, unknown> = { text: request.text };

  const voiceInputKey = await resolveReplicateVoiceInputKey({
    provider: 'replicate',
    model,
    apiKey: request.apiKey,
  });
  if (voiceInputKey) {
    input[voiceInputKey] = request.voice;
  } else {
    input.voice = request.voice;
  }

  // Best-effort generic fields for custom models.
  if (request.format !== 'mp3') {
    input.audio_format = 'wav';
  }

  if (request.speed !== 1) {
    input.speed = request.speed;
  }

  if (request.instructions) {
    input.instructions = request.instructions;
  }

  return input;
}

async function runReplicateRequest(
  request: ResolvedServerTTSRequest,
  signal: AbortSignal,
  maxRetries: number,
): Promise<Buffer> {
  const replicate = new Replicate({ auth: request.apiKey });
  const input = await buildReplicateInput(request);
  const modelId = request.model as `${string}/${string}`;
  const cooldownScopeKey = getReplicateCooldownScopeKey(request);

  return runWithReplicateGate(cooldownScopeKey, signal, async () => {
    let attempt = 0;

    for (; ;) {
      try {
        const output = await replicate.run(modelId, { input, signal }) as unknown;

        const audioUrl = extractReplicateAudioUrl(output);
        if (!audioUrl) {
          throw new Error('Replicate output did not include a fetchable audio URL');
        }
        const audioResponse = await fetch(audioUrl, { signal });
        if (!audioResponse.ok) {
          const error = new Error(`Failed to fetch Replicate audio: ${audioResponse.status}`) as Error & {
            status?: number;
            statusCode?: number;
            response?: { status: number; headers: Headers };
          };
          error.status = audioResponse.status;
          error.statusCode = audioResponse.status;
          error.response = {
            status: audioResponse.status,
            headers: audioResponse.headers,
          };
          throw error;
        }
        const buffer = await audioResponse.arrayBuffer();
        return Buffer.from(buffer);
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw error;
        }

        const status = getUpstreamStatus(error) ?? 0;
        const retryable = status === 429 || status >= 500;
        const retryAfterSeconds = status === 429 ? getUpstreamRetryAfterSeconds(error) : undefined;
        const delay = retryAfterSeconds ? Math.max(retryAfterSeconds * 1000, 1000) : 10_000;
        if (status === 429) {
          applyReplicateCooldown(cooldownScopeKey, delay);
        }

        if (!retryable || attempt >= maxRetries) {
          throw error;
        }

        await sleepWithSignal(delay, signal);
        attempt += 1;
      }
    }
  });
}

async function runProviderRequest(
  request: ResolvedServerTTSRequest,
  signal: AbortSignal,
  upstreamSettings: ResolvedTtsUpstreamRuntimeSettings,
): Promise<Buffer> {
  const mockBuffer = await getTestMockTtsBuffer(request.testNamespace);
  if (mockBuffer) return mockBuffer;

  if (request.provider === 'replicate') {
    return runReplicateRequest(request, signal, upstreamSettings.ttsUpstreamMaxRetries);
  }

  const openai = new OpenAI({
    apiKey: request.apiKey,
    baseURL: request.baseUrl,
    maxRetries: 0,
    timeout: upstreamSettings.ttsUpstreamTimeoutMs,
  });

  const createParams: ExtendedSpeechParams = {
    model: request.model,
    voice: request.voice as SpeechCreateParams['voice'],
    input: request.text,
    speed: request.speed,
    response_format: request.format as SpeechCreateParams['response_format'],
  };

  if (request.instructions) {
    createParams.instructions = request.instructions;
  }

  return fetchTTSBufferWithRetry(openai, createParams, signal, upstreamSettings.ttsUpstreamMaxRetries);
}

export async function generateTTSBuffer(
  request: ServerTTSRequest,
  signal?: AbortSignal,
  runtimeSettings?: TtsUpstreamRuntimeSettings,
): Promise<Buffer> {
  const upstreamSettings = resolveTtsUpstreamSettings(runtimeSettings);
  ensureTtsAudioCache(upstreamSettings);

  const resolved = resolveTTSRequest(request);
  const cacheKey = makeCacheKey({
    provider: resolved.provider,
    model: resolved.model,
    voice: resolved.voice,
    speed: resolved.speed,
    format: resolved.format,
    text: resolved.text,
    instructions: resolved.instructions,
    testNamespace: resolved.testNamespace,
  });

  const cachedBuffer = ttsAudioCache.get(cacheKey);
  if (cachedBuffer) return cachedBuffer;

  const existing = inflightRequests.get(cacheKey);
  if (existing) {
    existing.consumers += 1;

    const onAbort = () => {
      existing.consumers = Math.max(0, existing.consumers - 1);
      if (existing.consumers === 0) {
        existing.controller.abort();
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await existing.promise;
    } finally {
      try {
        signal?.removeEventListener('abort', onAbort);
      } catch { }
    }
  }

  const controller = new AbortController();
  const entry: InflightEntry = {
    controller,
    consumers: 1,
    promise: (async () => {
      try {
        const buffer = await runProviderRequest(resolved, controller.signal, upstreamSettings);
        ttsAudioCache.set(cacheKey, buffer);
        return buffer;
      } finally {
        inflightRequests.delete(cacheKey);
      }
    })(),
  };

  inflightRequests.set(cacheKey, entry);

  const onAbort = () => {
    entry.consumers = Math.max(0, entry.consumers - 1);
    if (entry.consumers === 0) {
      entry.controller.abort();
    }
  };

  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await entry.promise;
  } finally {
    try {
      signal?.removeEventListener('abort', onAbort);
    } catch { }
  }
}

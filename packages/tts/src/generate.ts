import OpenAI from 'openai';
import { fishReferenceRequest } from './fish-audio';
import { OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODEL, normalizeOpenRouterOptions, openRouterCapabilities, openRouterRequestOptions, pcmToWav, splitOpenRouterInput, validateOpenRouterReferences } from './openrouter';
import Replicate from 'replicate';
import { SpeechCreateParams } from 'openai/resources/audio/speech.mjs';
import {
  isBuiltInTtsProviderId,
  KOKORO_LOCAL_MODEL,
  isRetiredReplicateModel,
  replicateExecutionModel,
  FISH_AUDIO_MODELS,
} from './provider-catalog';
import { defaultBaseUrlForProviderType, resolveTtsProviderModelPolicy } from './provider-policy';
import {
  resolveReplicateLanguageInput,
  resolveReplicateVoiceInputKey,
} from './voice-resolution';
import { getUpstreamRetryAfterSeconds, getUpstreamStatus } from './upstream-response';
import { appendCbrSilence, normalizeToMp3 } from './audio-format';
import { effectiveVoiceCustomization, voiceCustomizationCacheKey, type VoiceCustomization } from './voice-customization';
import { LRUCache } from 'lru-cache';
import { createHash } from 'crypto';
import {
  getLanguageDisplayName,
  toBaseLanguageCode,
} from './language';

export interface ServerTTSRequest {
  referenceAudio?: import('./cloned-voices').VoiceReferenceAudio;
  text: string;
  voice: string;
  speed: number;
  format?: string;
  model?: string | null;
  instructions?: string;
  modelOptions?: string;
  language?: string;
  provider: string;
  apiKey: string;
  baseUrl?: string;
  voiceCustomization?: VoiceCustomization;
}

type CustomVoice = string;
type ExtendedSpeechParams = Omit<SpeechCreateParams, 'voice'> & {
  voice: SpeechCreateParams['voice'] | CustomVoice;
  instructions?: string;
  language?: string;
};

type ResolvedServerTTSRequest = {
  referenceAudio?: import('./cloned-voices').VoiceReferenceAudio;
  text: string;
  voice: string;
  speed: number;
  format: string;
  model: SpeechCreateParams['model'];
  instructions?: string;
  modelOptions?: string;
  language?: string;
  provider: string;
  apiKey: string;
  baseUrl?: string;
  voiceCustomization?: VoiceCustomization;
};

/**
 * Synthesizes `kokoro-local` audio inside the calling process. The compute
 * worker registers its ONNX engine at startup, so this package (and the
 * Next.js app that imports it) never loads a model. Returns any audio format
 * `normalizeToMp3` accepts.
 */
export type LocalTtsSynthesizer = (
  request: { text: string; voice: string; speed: number; customization?: VoiceCustomization },
  signal: AbortSignal,
) => Promise<Buffer>;

let localSynthesizer: LocalTtsSynthesizer | null = null;

export function registerLocalTtsSynthesizer(synthesize: LocalTtsSynthesizer | null): void {
  localSynthesizer = synthesize;
}

type InflightEntry = {
  promise: Promise<Buffer>;
  controller: AbortController;
  consumers: number;
};

const REPLICATE_COOLDOWN_SCOPE_CACHE_MAX_ENTRIES = 512;
const replicateBlockedUntilByScope = new LRUCache<string, number>({
  max: REPLICATE_COOLDOWN_SCOPE_CACHE_MAX_ENTRIES,
});
const openAiCompatibleLanguageUnsupported = new LRUCache<string, true>({ max: 256 });
// Tracks OpenAI-compatible servers that reject an explicit `response_format` (e.g.
// wav-only servers that 400 on `response_format: mp3`). After the first rejection
// we omit the field and let the server emit its default, which `normalizeToMp3`
// then converts. In-memory + per-process: on serverless this may re-probe once per
// cold instance, which is harmless; on long-running self-hosted it persists.
const openAiCompatibleResponseFormatUnsupported = new LRUCache<string, true>({ max: 256 });

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

// Replicate serves all model output files from replicate.delivery and its
// subdomains (https://replicate.com/docs/topics/predictions/output-files).
// The extraction walker below picks up any URL string a model emits in its
// output, so a malicious third-party model could otherwise return an internal
// address (e.g. http://169.254.169.254/...) and turn this into an SSRF read.
// Restricting fetchable hosts to replicate.delivery closes that without
// affecting legitimate audio outputs, which always come from there.
const REPLICATE_OUTPUT_HOST = 'replicate.delivery';

function isAllowedReplicateOutputHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === REPLICATE_OUTPUT_HOST || host.endsWith(`.${REPLICATE_OUTPUT_HOST}`);
}

function normalizeReplicateUrlCandidate(value: unknown): string | null {
  if (value instanceof URL) {
    return isAllowedReplicateOutputHost(value.hostname) ? value.toString() : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  // data: URIs are resolved inline by fetch with no network egress, so they
  // carry no SSRF risk and need no host check.
  if (trimmed.startsWith('data:')) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return isAllowedReplicateOutputHost(parsed.hostname) ? trimmed : null;
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

// Private-use code points are font-specific glyphs (Word's Symbol/Wingdings
// bullets) with no pronunciation; some providers reject the whole request.
const PRIVATE_USE_CHARACTERS = /\p{Co}/gu;

function resolveTTSRequest(input: ServerTTSRequest): ResolvedServerTTSRequest {
  const provider = input.provider || 'openai';
  const providerType = isBuiltInTtsProviderId(provider) ? provider : 'openai';
  const rawModel = provider === 'deepinfra' && !input.model ? 'hexgrad/Kokoro-82M'
    : provider === 'openrouter' && !input.model ? OPENROUTER_DEFAULT_MODEL
    : provider === 'fish-audio' && !input.model ? 's2.1-pro-free'
    : provider === 'replicate' && !input.model ? 'google/gemini-3.1-flash-tts'
    : provider === 'kokoro-local' ? KOKORO_LOCAL_MODEL
    : input.model;
  const model = (rawModel ?? 'gpt-4o-mini-tts') as SpeechCreateParams['model'];
  const providerModelPolicy = resolveTtsProviderModelPolicy({
    providerRef: provider,
    providerType,
    model: model as string,
  });

  const normalizedVoice = (
    providerType !== 'openrouter' && (providerType === 'replicate' || !providerModelPolicy.isKokoroModel) && input.voice.includes('+')
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
    text: input.text.replace(PRIVATE_USE_CHARACTERS, ''),
    referenceAudio: input.referenceAudio,
    voice: normalizedVoice,
    speed,
    format,
    model,
    instructions,
    ...(provider === 'openrouter' && input.modelOptions ? { modelOptions: normalizeOpenRouterOptions(input.modelOptions, model) } : {}),
    language: input.language,
    provider,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    ...(voiceCustomizationCacheKey(input.voiceCustomization, provider)
      ? { voiceCustomization: effectiveVoiceCustomization(input.voiceCustomization, provider) } : {}),
  };
}

function makeCacheKey(input: {
  referenceAudio?: import('./cloned-voices').VoiceReferenceAudio;
  provider: string;
  model: string | null | undefined;
  voice: string | undefined;
  speed: number;
  format: string;
  text: string;
  instructions?: string;
  modelOptions?: string;
  language?: string;
  voiceCustomization?: VoiceCustomization;
}) {
  const canonical = {
    ...(input.referenceAudio ? { referenceHash: createHash('sha256').update(JSON.stringify(input.referenceAudio)).digest('hex') } : {}),
    provider: input.provider,
    model: input.model || '',
    voice: input.voice || '',
    speed: input.speed,
    format: input.format,
    text: input.text,
    instructions: input.instructions || undefined,
    ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
    language: input.language || undefined,
    ...(voiceCustomizationCacheKey(input.voiceCustomization, input.provider)
      ? { voiceCustomization: voiceCustomizationCacheKey(input.voiceCustomization, input.provider) } : {}),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function buildTTSCacheKey(request: ServerTTSRequest): string {
  const resolved = resolveTTSRequest(request);
  return makeCacheKey({
    referenceAudio: resolved.referenceAudio,
    provider: resolved.provider,
    model: resolved.model,
    voice: resolved.voice,
    speed: resolved.speed,
    format: resolved.format,
    text: resolved.text,
    instructions: resolved.instructions,
    modelOptions: resolved.modelOptions,
    language: resolved.language,
    voiceCustomization: resolved.voiceCustomization,
  });
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

export async function buildReplicateInput(request: ResolvedServerTTSRequest): Promise<Record<string, unknown>> {
  if (isRetiredReplicateModel(request.model as string)) {
    // This is an explicit local rejection, not a retryable provider failure.
    // Do not rewrite the saved model: existing durable audio keeps its key.
    throw Object.assign(new Error('This Replicate model has been removed. Choose another model in provider settings.'), { status: 422 });
  }
  const model = replicateExecutionModel(request.model as string);

  if (model === 'google/gemini-3.1-flash-tts') {
    const input: Record<string, unknown> = {
      text: request.text,
      voice: request.voice,
    };
    if (request.instructions) {
      input.prompt = request.instructions;
    }
    return addReplicateLanguageInput(input, request);
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
    return addReplicateLanguageInput(input, request);
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
    return addReplicateLanguageInput(input, request);
  }

  if (model === 'inworld/realtime-tts-1.5-mini') {
    const input: Record<string, unknown> = {
      text: request.text,
      voice_id: request.voice,
      audio_format: request.format === 'mp3' ? 'mp3' : 'wav',
    };
    if (request.speed !== 1) {
      input.speaking_rate = request.speed;
    }
    return addReplicateLanguageInput(input, request);
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

  return addReplicateLanguageInput(input, request);
}

async function addReplicateLanguageInput(
  input: Record<string, unknown>,
  request: ResolvedServerTTSRequest,
): Promise<Record<string, unknown>> {
  if (!request.language) return input;
  const languageInput = await resolveReplicateLanguageInput({
    provider: 'replicate',
    model: request.model as string,
    apiKey: request.apiKey,
  });
  if (languageInput) {
    const resolvedValue = resolveReplicateLanguageValue(request.language, languageInput.allowedValues);
    if (resolvedValue) {
      input[languageInput.key] = resolvedValue;
    }
  }
  return input;
}

// Models with region-only codes (Gemini's `en-US`, `ja-JP`) need a bare
// language expanded to its most likely region rather than omitted.
function likelyRegionalLanguageTag(language: string): string | null {
  try {
    const locale = new Intl.Locale(language).maximize();
    return locale.region ? `${locale.language}-${locale.region}` : null;
  } catch {
    return null;
  }
}

export function resolveReplicateLanguageValue(language: string, allowedValues: string[]): string | null {
  if (allowedValues.length === 0) return language;

  const baseLanguage = toBaseLanguageCode(language);
  const candidates = [
    language,
    baseLanguage,
    likelyRegionalLanguageTag(language),
    getLanguageDisplayName(language),
    getLanguageDisplayName(baseLanguage),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const allowedByLowercase = new Map(
    allowedValues.map((value) => [value.toLocaleLowerCase(), value]),
  );
  return candidates
    .map((candidate) => allowedByLowercase.get(candidate.toLocaleLowerCase()))
    .find((candidate): candidate is string => Boolean(candidate)) ?? null;
}

async function runReplicateRequest(
  request: ResolvedServerTTSRequest,
  signal: AbortSignal,
  maxRetries: number,
): Promise<Buffer> {
  const replicate = new Replicate({ auth: request.apiKey });
  const input = await buildReplicateInput(request);
  const modelId = replicateExecutionModel(request.model as string) as `${string}/${string}`;
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

function runLocalRequest(request: ResolvedServerTTSRequest, signal: AbortSignal): Promise<Buffer> {
  if (!localSynthesizer) {
    throw new Error('The local Kokoro provider runs only in the compute worker');
  }
  return localSynthesizer({ text: request.text, voice: request.voice, speed: request.speed,
    ...(request.voiceCustomization ? { customization: request.voiceCustomization } : {}) }, signal);
}

async function runOpenRouterRequest(
  request: ResolvedServerTTSRequest,
  signal: AbortSignal,
  settings: ResolvedTtsUpstreamRuntimeSettings,
): Promise<Buffer> {
  const pieces = splitOpenRouterInput(request.text);
  if (pieces.length > 1) {
    const chunks: Buffer[] = []; let bytes = 0;
    for (const text of pieces) {
      signal.throwIfAborted();
      const audio = await runOpenRouterRequest({ ...request, text }, signal, settings);
      const normalized = await normalizeToMp3(audio, signal);
      bytes += normalized.byteLength;
      if (bytes > 32 * 1024 * 1024) throw new Error('OpenRouter segment exceeded the audio size limit');
      chunks.push(normalized);
    }
    return Buffer.concat(chunks, bytes);
  }
  if (!request.apiKey) throw Object.assign(new Error('OpenRouter needs an API key.'), { status: 401 });
  const capabilities = openRouterCapabilities(request.model);
  const options = openRouterRequestOptions(request.modelOptions, request.model);
  if (request.referenceAudio) {
    options.input_references = [
      { type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${request.referenceAudio.audio}` } },
      ...(request.referenceAudio.transcript ? [{ type: 'text' as const, text: request.referenceAudio.transcript }] : []),
    ];
  }
  await validateOpenRouterReferences(request.model, options, signal);
  const body = JSON.stringify({
    ...options, model: request.model, input: request.text,
    ...(!options.input_references?.some(part => part.type === 'input_audio') && request.voice && request.voice !== 'default' ? { voice: request.voice } : {}),
    ...(request.instructions ? { instructions: request.instructions } : {}),
    ...(capabilities.nativeSpeed ? { speed: Math.max(0.5, Math.min(2, request.speed)) } : {}),
    response_format: capabilities.format,
  });
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(settings.ttsUpstreamTimeoutMs)]);
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${OPENROUTER_BASE_URL}/audio/speech`, {
      method: 'POST', headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': 'application/json' },
      body, signal: deadline, redirect: 'error',
    });
    if (response.ok) {
      if (!response.body) throw new Error('OpenRouter returned no audio');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 32 * 1024 * 1024) throw new Error('OpenRouter response exceeded the audio size limit');
          chunks.push(value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      if (!bytes) throw new Error('OpenRouter returned no audio');
      const audio = Buffer.concat(chunks, bytes);
      return capabilities.format === 'pcm' ? Buffer.from(pcmToWav(audio, capabilities.pcmSampleRate)) : audio;
    }
    await response.body?.cancel();
    const error = Object.assign(new Error(`OpenRouter returned HTTP ${response.status}`), {
      status: response.status, response: { status: response.status, headers: response.headers },
    });
    if ((response.status !== 429 && response.status < 500) || attempt >= settings.ttsUpstreamMaxRetries) throw error;
    await sleepWithSignal((getUpstreamRetryAfterSeconds(error) ?? Math.min(2 ** attempt, 4)) * 1000, deadline);
  }
}

async function runFishAudioRequest(
  request: ResolvedServerTTSRequest,
  signal: AbortSignal,
  settings: ResolvedTtsUpstreamRuntimeSettings,
): Promise<Buffer> {
  if (!FISH_AUDIO_MODELS.some(({ id }) => id === request.model)) {
    throw Object.assign(new Error('Choose a supported Fish Audio model in provider settings.'), { status: 422 });
  }
  if (!request.apiKey) {
    throw Object.assign(new Error('Fish Audio needs an API key.'), { status: 401 });
  }
  // Add direction only at the provider boundary, after citation/bracket
  // filtering. Display text and alignment still use the original passage.
  const direction = request.instructions?.replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  const text = direction ? `[${direction}] ${request.text}` : request.text;
  const body = request.referenceAudio ? Buffer.from(fishReferenceRequest({ text, speed: request.speed,
    reference: request.referenceAudio, language: request.language })) : JSON.stringify({
    text,
    format: 'mp3',
    ...(request.voice && request.voice !== 'default' ? { reference_id: request.voice } : {}),
    prosody: { speed: Math.max(0.5, Math.min(2, request.speed)) },
    ...(request.language ? { language: request.language } : {}),
  });
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(settings.ttsUpstreamTimeoutMs)]);
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch('https://api.fish.audio/v1/tts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${request.apiKey}`, 'Content-Type': request.referenceAudio ? 'application/msgpack' : 'application/json', model: request.model },
      body,
      signal: deadline,
      redirect: 'error',
    });
    if (response.ok) {
      if (!response.body) throw new Error('Fish Audio returned no audio');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 32 * 1024 * 1024) throw new Error('Fish Audio response exceeded the audio size limit');
          chunks.push(value);
        }
        if (!bytes) throw new Error('Fish Audio returned no audio');
        return Buffer.concat(chunks, bytes);
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }
    // Never include upstream bodies: services may echo credentials or text.
    const error = Object.assign(new Error(`Fish Audio returned HTTP ${response.status}`), {
      status: response.status, response: { status: response.status, headers: response.headers },
    });
    await response.body?.cancel();
    if ((response.status !== 429 && response.status < 500) || attempt >= settings.ttsUpstreamMaxRetries) throw error;
    const delay = (getUpstreamRetryAfterSeconds(error) ?? 0) * 1000
      || Math.min(OPENAI_RETRY_INITIAL_DELAY_MS * 2 ** attempt, OPENAI_RETRY_MAX_DELAY_MS);
    await sleepWithSignal(delay, deadline);
  }
}

async function runProviderRequest(
  request: ResolvedServerTTSRequest,
  signal: AbortSignal,
  upstreamSettings: ResolvedTtsUpstreamRuntimeSettings,
): Promise<Buffer> {
  const providerStartedAt = Date.now();
  const raw = request.provider === 'kokoro-local'
    ? await runLocalRequest(request, signal)
    : request.provider === 'openrouter'
      ? await runOpenRouterRequest(request, signal, upstreamSettings)
    : request.provider === 'fish-audio'
      ? await runFishAudioRequest(request, signal, upstreamSettings)
      : request.provider === 'replicate'
        ? await runReplicateRequest(request, signal, upstreamSettings.ttsUpstreamMaxRetries)
        : await runOpenAiCompatibleRequest(request, signal, upstreamSettings);
  const providerMs = Date.now() - providerStartedAt;

  // OpenAI-compatible servers (and some Replicate models) may emit wav/ogg/etc.;
  // Normalize to MP3 so playback storage and document export stay MP3-only.
  const normalized = await normalizeToMp3(raw, signal, {
    provider: request.provider,
    model: request.model,
    textLength: request.text.length,
    providerMs,
  });
  return request.provider === 'kokoro-local' ? normalized
    : appendCbrSilence(normalized, request.voiceCustomization?.blockPauseMilliseconds ?? 0, signal);
}

/**
 * Shared providers only store a base URL for custom endpoints. Without the
 * provider's own default, the OpenAI SDK would send a Deepinfra key to OpenAI.
 */
function openAiCompatibleBaseUrl(request: ResolvedServerTTSRequest): string | undefined {
  if (request.baseUrl) return request.baseUrl;
  return isBuiltInTtsProviderId(request.provider)
    ? defaultBaseUrlForProviderType(request.provider) || undefined
    : undefined;
}

async function runOpenAiCompatibleRequest(
  request: ResolvedServerTTSRequest,
  signal: AbortSignal,
  upstreamSettings: ResolvedTtsUpstreamRuntimeSettings,
): Promise<Buffer> {
  const openai = new OpenAI({
    // The SDK constructor rejects an empty apiKey, but many OpenAI-compatible
    // servers (e.g. a local Supertonic/Kokoro) need no auth. Pass a placeholder to
    // satisfy the constructor; `defaultHeaders` clears the Authorization header
    // (merged after the bearer auth, and allowed by validateHeaders), so the
    // placeholder is never sent.
    apiKey: request.apiKey || 'no-key',
    baseURL: openAiCompatibleBaseUrl(request),
    defaultHeaders: request.apiKey ? undefined : { Authorization: null },
    maxRetries: 0,
    timeout: upstreamSettings.ttsUpstreamTimeoutMs,
  });

  const formatKey = `${request.provider}|${request.baseUrl || ''}|${request.model as string}`;
  const skipResponseFormat = openAiCompatibleResponseFormatUnsupported.has(formatKey);

  const createParams: ExtendedSpeechParams = {
    model: request.model,
    voice: request.voice as SpeechCreateParams['voice'],
    input: request.text,
    speed: request.speed,
  };
  if (!skipResponseFormat) {
    createParams.response_format = request.format as SpeechCreateParams['response_format'];
  }
  if (request.instructions) {
    createParams.instructions = request.instructions;
  }

  // Inner attempt with the existing language-unsupported fallback.
  const fetchWithLanguageFallback = async (params: ExtendedSpeechParams): Promise<Buffer> => {
    if (request.provider !== 'openai' && request.language) {
      const supportKey = `${request.provider}|${request.baseUrl || ''}|${request.model as string}|${request.language}`;
      if (!openAiCompatibleLanguageUnsupported.has(supportKey)) {
        try {
          return await fetchTTSBufferWithRetry(
            openai,
            { ...params, language: request.language },
            signal,
            upstreamSettings.ttsUpstreamMaxRetries,
          );
        } catch (error) {
          const status = getUpstreamStatus(error);
          if (status !== 400 && status !== 422) throw error;
          const fallback = await fetchTTSBufferWithRetry(
            openai,
            params,
            signal,
            upstreamSettings.ttsUpstreamMaxRetries,
          );
          openAiCompatibleLanguageUnsupported.set(supportKey, true);
          return fallback;
        }
      }
    }
    return fetchTTSBufferWithRetry(openai, params, signal, upstreamSettings.ttsUpstreamMaxRetries);
  };

  try {
    return await fetchWithLanguageFallback(createParams);
  } catch (error) {
    const status = getUpstreamStatus(error);
    // A wav-only server rejects the explicit mp3 `response_format`. Retry once
    // without it, cache the decision, and let `normalizeToMp3` convert the result.
    const canRetryWithoutFormat = request.provider !== 'openai'
      && (status === 400 || status === 422)
      && !skipResponseFormat
      && createParams.response_format !== undefined;
    if (!canRetryWithoutFormat) throw error;

    openAiCompatibleResponseFormatUnsupported.set(formatKey, true);
    const { response_format: _omitted, ...withoutFormat } = createParams;
    void _omitted;
    return fetchWithLanguageFallback(withoutFormat as ExtendedSpeechParams);
  }
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
    referenceAudio: resolved.referenceAudio,
    provider: resolved.provider,
    model: resolved.model,
    voice: resolved.voice,
    speed: resolved.speed,
    format: resolved.format,
    text: resolved.text,
    instructions: resolved.instructions,
    modelOptions: resolved.modelOptions,
    language: resolved.language,
    voiceCustomization: resolved.voiceCustomization,
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

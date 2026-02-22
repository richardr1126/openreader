import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { SpeechCreateParams } from 'openai/resources/audio/speech.mjs';
import { isKokoroModel } from '@/lib/shared/kokoro';
import { LRUCache } from 'lru-cache';
import { createHash } from 'crypto';
import type { TTSRequestPayload } from '@/types/client';
import type { TTSError, TTSAudioBuffer } from '@/types/tts';
import { headers } from 'next/headers';
import { auth } from '@/lib/server/auth/auth';
import { rateLimiter, RATE_LIMITS, isTtsRateLimitEnabled } from '@/lib/server/rate-limit/rate-limiter';
import { isAuthEnabled } from '@/lib/server/auth/config';
import { getClientIp } from '@/lib/server/rate-limit/request-ip';
import { getOrCreateDeviceId, setDeviceIdCookie } from '@/lib/server/rate-limit/device-id';

export const runtime = 'nodejs';
export const maxDuration = 60;

function attachDeviceIdCookie(response: NextResponse, deviceId: string | null, didCreate: boolean) {
  if (didCreate && deviceId) {
    setDeviceIdCookie(response, deviceId);
  }
}

type CustomVoice = string;
type ExtendedSpeechParams = Omit<SpeechCreateParams, 'voice'> & {
  voice: SpeechCreateParams['voice'] | CustomVoice;
  instructions?: string;
};
type AudioBufferValue = TTSAudioBuffer;

const TTS_CACHE_MAX_SIZE_BYTES = Number(process.env.TTS_CACHE_MAX_SIZE_BYTES || 256 * 1024 * 1024); // 256MB
const TTS_CACHE_TTL_MS = Number(process.env.TTS_CACHE_TTL_MS || 1000 * 60 * 30); // 30 minutes

const ttsAudioCache = new LRUCache<string, AudioBufferValue>({
  maxSize: TTS_CACHE_MAX_SIZE_BYTES,
  sizeCalculation: (value) => value.byteLength,
  ttl: TTS_CACHE_TTL_MS,
});

type InflightEntry = {
  promise: Promise<TTSAudioBuffer>;
  controller: AbortController;
  consumers: number;
};

const inflightRequests = new Map<string, InflightEntry>();

const PROBLEM_TYPES = {
  dailyQuotaExceeded: 'https://openreader.app/problems/daily-quota-exceeded',
  upstreamRateLimited: 'https://openreader.app/problems/upstream-rate-limited',
} as const;

type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
  [key: string]: unknown;
};

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function fetchTTSBufferWithRetry(
  openai: OpenAI,
  createParams: ExtendedSpeechParams,
  signal: AbortSignal
): Promise<TTSAudioBuffer> {
  let attempt = 0;
  const maxRetries = Number(process.env.TTS_MAX_RETRIES ?? 2);
  let delay = Number(process.env.TTS_RETRY_INITIAL_MS ?? 250);
  const maxDelay = Number(process.env.TTS_RETRY_MAX_MS ?? 2000);
  const backoff = Number(process.env.TTS_RETRY_BACKOFF ?? 2);

  // Retry on 429 and 5xx only; never retry aborts
  for (; ;) {
    try {
      const response = await openai.audio.speech.create(createParams as SpeechCreateParams, { signal });
      return await response.arrayBuffer();
    } catch (err: unknown) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err;
      }
      const status = (() => {
        if (typeof err === 'object' && err !== null) {
          const rec = err as Record<string, unknown>;
          if (typeof rec.status === 'number') return rec.status as number;
          if (typeof rec.statusCode === 'number') return rec.statusCode as number;
        }
        return 0;
      })();
      const retryable = status === 429 || status >= 500;
      if (!retryable || attempt >= maxRetries) {
        throw err;
      }
      await sleep(Math.min(delay, maxDelay));
      delay = Math.min(maxDelay, delay * backoff);
      attempt += 1;
    }
  }
}

function makeCacheKey(input: {
  provider: string;
  model: string | null | undefined;
  voice: string | undefined;
  speed: number;
  format: string;
  text: string;
  instructions?: string;
}) {
  const canonical = {
    provider: input.provider,
    model: input.model || '',
    voice: input.voice || '',
    speed: input.speed,
    format: input.format,
    text: input.text,
    // Only include instructions when present (for models like gpt-4o-mini-tts)
    instructions: input.instructions || undefined,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function formatLimitForHint(limit: number): string {
  if (!Number.isFinite(limit) || limit <= 0) return String(limit);
  if (limit >= 1_000_000) {
    const m = limit / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (limit >= 1_000) return `${Math.round(limit / 1_000)}K`;
  return String(limit);
}

export async function POST(req: NextRequest) {
  let providerForError: string | null = null;
  try {
    // Parse body first to get text for rate limiting
    const body = (await req.json()) as TTSRequestPayload;
    const { text, voice, speed, format, model: req_model, instructions } = body;

    if (!text || !voice || !speed) {
      const errorBody: TTSError = {
        code: 'MISSING_PARAMETERS',
        message: 'Missing required parameters',
      };
      return NextResponse.json(errorBody, { status: 400 });
    }

    // Auth and TTS char rate limiting check (only when auth is enabled)
    let didCreateDeviceIdCookie = false;
    let deviceIdToSet: string | null = null;

    if (isAuthEnabled() && auth) {
      const session = await auth.api.getSession({
        headers: await headers()
      });

      if (!session?.user) {
        return NextResponse.json(
          { code: 'UNAUTHORIZED', message: 'Authentication required' },
          { status: 401 }
        );
      }

      const isAnonymous = Boolean(session.user.isAnonymous);
      if (isTtsRateLimitEnabled()) {
        const charCount = text.length;
        const ip = getClientIp(req);
        const device = isAnonymous ? getOrCreateDeviceId(req) : null;
        if (device?.didCreate) {
          didCreateDeviceIdCookie = true;
          deviceIdToSet = device.deviceId;
        }

        // Check rate limit
        const rateLimitResult = await rateLimiter.checkAndIncrementLimit(
          { id: session.user.id, isAnonymous },
          charCount,
          {
            deviceId: device?.deviceId ?? null,
            ip,
          }
        );

        if (!rateLimitResult.allowed) {
          const resetTimeMs = rateLimitResult.resetTimeMs;
          const retryAfterSeconds = Math.max(
            0,
            Math.ceil((resetTimeMs - Date.now()) / 1000)
          );

          const problem: ProblemDetails = {
            type: PROBLEM_TYPES.dailyQuotaExceeded,
            title: 'Daily quota exceeded',
            status: 429,
            detail: 'Daily character limit exceeded',
            code: 'USER_DAILY_QUOTA_EXCEEDED',
            currentCount: rateLimitResult.currentCount,
            limit: rateLimitResult.limit,
            remainingChars: rateLimitResult.remainingChars,
            resetTimeMs,
            userType: isAnonymous ? 'anonymous' : 'authenticated',
            upgradeHint: isAnonymous
              ? `Sign up to increase your limit from ${formatLimitForHint(RATE_LIMITS.ANONYMOUS)} to ${formatLimitForHint(RATE_LIMITS.AUTHENTICATED)} characters per day`
              : undefined,
            instance: req.nextUrl.pathname,
          };

          const response = new NextResponse(JSON.stringify(problem), {
            status: 429,
            headers: {
              'Content-Type': 'application/problem+json',
              'Retry-After': String(retryAfterSeconds),
            },
          });

          attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);

          return response;
        }
      }
    }

    // Get API credentials from headers or fall back to environment variables
    const openApiKey = req.headers.get('x-openai-key') || process.env.API_KEY || 'none';
    const openApiBaseUrl = req.headers.get('x-openai-base-url') || process.env.API_BASE;
    const provider = req.headers.get('x-tts-provider') || 'openai';
    providerForError = provider;
    console.log('Received TTS request:', { provider, req_model, voice, speed, format, hasInstructions: Boolean(instructions) });
    // Use default Kokoro model for Deepinfra if none specified, then fall back to a safe default
    const rawModel = provider === 'deepinfra' && !req_model ? 'hexgrad/Kokoro-82M' : req_model;
    const model: SpeechCreateParams['model'] = (rawModel ?? 'gpt-4o-mini-tts') as SpeechCreateParams['model'];

    // Initialize OpenAI client with abort signal (OpenAI/deepinfra)
    const openai = new OpenAI({
      apiKey: openApiKey,
      baseURL: openApiBaseUrl,
      // Keep retry policy centralized in this route's fetchTTSBufferWithRetry.
      maxRetries: 0,
      // Keep upstream timeout below route max duration so we can return a controlled error.
      timeout: Number(process.env.TTS_UPSTREAM_TIMEOUT_MS ?? 45_000),
    });

    const normalizedVoice = (
      !isKokoroModel(model as string) && voice.includes('+')
        ? (voice.split('+')[0].trim())
        : voice
    ) as SpeechCreateParams['voice'];

    const resolvedFormat = format || 'mp3';

    const createParams: ExtendedSpeechParams = {
      model: model,
      voice: normalizedVoice,
      input: text,
      speed: speed,
      response_format: resolvedFormat,
    };
    // Only add instructions if model is gpt-4o-mini-tts and instructions are provided
    if ((model as string) === 'gpt-4o-mini-tts' && instructions) {
      createParams.instructions = instructions;
    }

    // Compute cache key and check LRU before making provider call
    const contentType = 'audio/mpeg';

    // Preserve voice string as-is for cache key (no weight stripping)
    const voiceForKey = typeof createParams.voice === 'string'
      ? createParams.voice
      : String(createParams.voice);

    const cacheKey = makeCacheKey({
      provider,
      model: createParams.model,
      voice: voiceForKey,
      speed: Number(createParams.speed),
      format: String(createParams.response_format),
      text,
      instructions: createParams.instructions,
    });

    const etag = `W/"${cacheKey}"`;
    const ifNoneMatch = req.headers.get('if-none-match');

    const cachedBuffer = ttsAudioCache.get(cacheKey);
    if (cachedBuffer) {
      if (ifNoneMatch && (ifNoneMatch.includes(cacheKey) || ifNoneMatch.includes(etag))) {
        const response = new NextResponse(null, {
          status: 304,
          headers: {
            'ETag': etag,
            'Cache-Control': 'private, max-age=1800',
            'Vary': 'x-tts-provider, x-openai-key, x-openai-base-url'
          }
        });

        attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);

        return response;
      }
      console.log('TTS cache HIT for key:', cacheKey.slice(0, 8));
      const response = new NextResponse(cachedBuffer, {
        headers: {
          'Content-Type': contentType,
          'X-Cache': 'HIT',
          'ETag': etag,
          'Content-Length': String(cachedBuffer.byteLength),
          'Cache-Control': 'private, max-age=1800',
          'Vary': 'x-tts-provider, x-openai-key, x-openai-base-url'
        }
      });

      attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);

      return response;
    }

    // De-duplicate identical in-flight requests
    const existing = inflightRequests.get(cacheKey);
    if (existing) {
      console.log('TTS in-flight JOIN for key:', cacheKey.slice(0, 8));
      existing.consumers += 1;

      const onAbort = () => {
        existing.consumers = Math.max(0, existing.consumers - 1);
        if (existing.consumers === 0) {
          existing.controller.abort();
        }
      };
      req.signal.addEventListener('abort', onAbort, { once: true });

      try {
        const buffer = await existing.promise;
        const response = new NextResponse(buffer, {
          headers: {
            'Content-Type': contentType,
            'X-Cache': 'INFLIGHT',
            'ETag': etag,
            'Content-Length': String(buffer.byteLength),
            'Cache-Control': 'private, max-age=1800',
            'Vary': 'x-tts-provider, x-openai-key, x-openai-base-url'
          }
        });

        attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);

        return response;
      } finally {
        try { req.signal.removeEventListener('abort', onAbort); } catch { }
      }
    }

    const controller = new AbortController();
    const entry: InflightEntry = {
      controller,
      consumers: 1,
      promise: (async () => {
        try {
          const buffer = await fetchTTSBufferWithRetry(openai, createParams, controller.signal);
          // Save to cache
          ttsAudioCache.set(cacheKey, buffer);
          return buffer;
        } finally {
          inflightRequests.delete(cacheKey);
        }
      })()
    };

    inflightRequests.set(cacheKey, entry);

    const onAbort = () => {
      entry.consumers = Math.max(0, entry.consumers - 1);
      if (entry.consumers === 0) {
        entry.controller.abort();
      }
    };
    req.signal.addEventListener('abort', onAbort, { once: true });

    let buffer: TTSAudioBuffer;
    try {
      buffer = await entry.promise;
    } finally {
      try { req.signal.removeEventListener('abort', onAbort); } catch { }
    }

    const response = new NextResponse(buffer, {
      headers: {
        'Content-Type': contentType,
        'X-Cache': 'MISS',
        'ETag': etag,
        'Content-Length': String(buffer.byteLength),
        'Cache-Control': 'private, max-age=1800',
        'Vary': 'x-tts-provider, x-openai-key, x-openai-base-url'
      }
    });

    attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);

    return response;
  } catch (error) {
    // Check if this was an abort error
    if (error instanceof Error && error.name === 'AbortError') {
      console.log('TTS request aborted by client');
      return new NextResponse(null, { status: 499 }); // Use 499 status for client closed request
    }

    const upstreamStatus = (() => {
      if (typeof error === 'object' && error !== null) {
        const rec = error as Record<string, unknown>;
        if (typeof rec.status === 'number') return rec.status as number;
        if (typeof rec.statusCode === 'number') return rec.statusCode as number;
      }
      return undefined;
    })();

    if (upstreamStatus === 429) {
      const problem: ProblemDetails = {
        type: PROBLEM_TYPES.upstreamRateLimited,
        title: 'Upstream rate limited',
        status: 429,
        detail: 'The TTS provider is rate limiting requests. Please try again shortly.',
        code: 'UPSTREAM_RATE_LIMIT',
        provider: providerForError ?? undefined,
        upstreamStatus,
        instance: req.nextUrl.pathname,
      };

      return new NextResponse(JSON.stringify(problem), {
        status: 429,
        headers: {
          'Content-Type': 'application/problem+json',
        },
      });
    }

    console.warn('Error generating TTS:', error);
    const errorBody: TTSError = {
      code: 'TTS_GENERATION_FAILED',
      message: 'Failed to generate audio',
      details: process.env.NODE_ENV !== 'production' ? String(error) : undefined,
    };
    return NextResponse.json(
      errorBody,
      { status: 500 }
    );
  }
}

import { generateTTSBuffer } from '@openreader/tts/generate';
import { resolveEffectiveTtsInstructions } from '@openreader/tts/instructions';
import { isBuiltInTtsProviderId } from '@openreader/tts/provider-catalog';
import { resolveTtsModelForProvider } from '@openreader/tts/provider-policy';
import {
  buildTtsPlaybackAudioContentHash,
  buildTtsPlaybackSegmentAudioKey,
  buildTtsSegmentTextHash,
  locatorFingerprint,
  normalizeLocator,
  normalizeSegmentText,
  probeAudioDurationMsFromBuffer,
} from '@openreader/tts/segments';
import type { TTSSegmentSettings } from '@openreader/tts/types';
import { getUpstreamRetryAfterSeconds, getUpstreamStatus } from '@openreader/tts/upstream-response';
import { runWhisperAlignmentFromAudioBuffer } from '../../inference/runtime';
import { withTimeout } from '../../infrastructure/config';
import type { TtsPlaybackStorage } from '../../playback/storage';
import { resolveTtsCredentials } from '../tts-credentials';
import { parseTtsSettings, type TtsPlaybackSegmentInput } from './plan';
import type { TtsPlaybackRequest } from './schemas';

const SEGMENT_MAX_ATTEMPTS = 2;
const GENERATION_LEASE_MIN_MS = 60_000;
const GENERATION_LEASE_GRACE_MS = 30_000;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class TtsPlaybackSegmentTimeoutError extends Error {
  readonly code = 'UPSTREAM_TIMEOUT';

  constructor(timeoutMs: number) {
    super(`TTS playback segment synthesis timed out after ${timeoutMs}ms`);
    this.name = 'TtsPlaybackSegmentTimeoutError';
  }
}

type SegmentErrorInfo = {
  message: string;
  code?: 'UPSTREAM_RATE_LIMIT' | 'UPSTREAM_ERROR' | 'UPSTREAM_TIMEOUT';
  upstreamStatus?: number;
  retryAfterSeconds?: number;
};

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

async function withAbortableTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const operation = run(controller.signal);
  try {
    return await withTimeout(operation, timeoutMs, label);
  } catch (error) {
    if (error instanceof Error && error.message === `${label} timed out after ${timeoutMs}ms`) {
      controller.abort();
      throw new TtsPlaybackSegmentTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    controller.abort();
  }
}

function textHmacSecret(): string {
  return process.env.AUTH_SECRET?.trim() || 'openreader-default-tts-segment-secret';
}

export function classifySegmentError(error: unknown): { info: SegmentErrorInfo; retryable: boolean } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TtsPlaybackSegmentTimeoutError) {
    return { info: { message, code: error.code }, retryable: false };
  }
  const upstreamStatus = getUpstreamStatus(error);
  if (upstreamStatus === undefined) return { info: { message }, retryable: true };
  if (upstreamStatus === 429) {
    const retryAfterSeconds = getUpstreamRetryAfterSeconds(error);
    return {
      info: { message, code: 'UPSTREAM_RATE_LIMIT', upstreamStatus, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) },
      retryable: true,
    };
  }
  if (upstreamStatus >= 500) {
    return { info: { message, code: 'UPSTREAM_ERROR', upstreamStatus }, retryable: true };
  }
  return { info: { message, code: 'UPSTREAM_ERROR', upstreamStatus }, retryable: false };
}

export async function generateExplicitTtsPlaybackSegments(input: {
  request: TtsPlaybackRequest;
  s3Prefix: string;
  segments: TtsPlaybackSegmentInput[];
  putAudioObject: (key: string, body: Buffer) => Promise<void>;
  deleteAudioObject?: (key: string) => Promise<void>;
  audioObjectExists: (key: string) => Promise<boolean>;
  playbackStorage?: TtsPlaybackStorage;
  readAudioObject?: (key: string) => Promise<Buffer>;
  cacheEpoch?: number;
  getCurrentCacheEpoch?: () => Promise<number>;
  synthesisTimeoutMs: number;
  onBeforeSegment?: (planOrdinal: number) => Promise<'continue' | 'stop'>;
  onSegmentCompleted?: (planOrdinal: number) => Promise<void>;
  onSegmentErrored?: (planOrdinal: number) => Promise<void>;
}): Promise<void> {
  if (input.segments.length === 0) return;

  const settings = parseTtsSettings(input.request.settingsJson);
  const requestCreds = await resolveTtsCredentials({ providerHeader: settings.providerRef });
  if ('error' in requestCreds) {
    throw new Error(`Unable to resolve TTS provider credentials: ${requestCreds.error}`);
  }

  const effectiveProviderRef = requestCreds.adminRecord?.slug || settings.providerRef;
  const resolvedProviderType = isBuiltInTtsProviderId(requestCreds.provider)
    ? requestCreds.provider
    : 'unknown';
  const effectiveModel = resolveTtsModelForProvider({
    providerRef: effectiveProviderRef,
    providerType: resolvedProviderType,
    model: settings.ttsModel,
    sharedProviders: requestCreds.adminRecord ? [requestCreds.adminRecord] : [],
    fallbackProviderRef: '',
    showAllProviderModels: true,
  });
  const effectiveSettings: TTSSegmentSettings = {
    ...settings,
    providerRef: effectiveProviderRef,
    providerType: resolvedProviderType,
    ttsModel: effectiveModel,
    ttsInstructions: resolveEffectiveTtsInstructions({
      model: effectiveModel,
      requestInstructions: settings.ttsInstructions,
      sharedDefaultInstructions: requestCreds.adminRecord?.defaultInstructions,
    }) ?? '',
  };

  const secret = textHmacSecret();
  const normalized = input.segments.map((segment) => {
    const text = normalizeSegmentText(segment.text);
    const locator = normalizeLocator(segment.locator as never);
    if (!text || !locator) return null;
    const segmentKey = typeof segment.segmentKey === 'string' && segment.segmentKey.trim()
      ? segment.segmentKey.trim()
      : null;
    return {
      original: segment,
      text,
      audioContentHash: buildTtsPlaybackAudioContentHash({
        documentId: input.request.documentId,
        documentVersion: input.request.documentVersion,
        settingsHash: input.request.settingsHash,
        ordinal: segment.ordinal,
        segmentKey,
        normalizedText: text,
        locatorFingerprint: locatorFingerprint(locator),
      }),
      segmentKey,
      textHash: buildTtsSegmentTextHash(text, secret),
    };
  }).filter((segment): segment is NonNullable<typeof segment> => Boolean(segment));
  if (normalized.length === 0) return;
  if (!input.playbackStorage) {
    throw new Error('TTS playback storage is required for segment generation');
  }
  const playbackStorage = input.playbackStorage;

  const readSidecar = (segment: (typeof normalized)[number]) =>
    playbackStorage.artifacts.readSegmentMetadata({
      storageUserId: input.request.storageUserId,
      documentId: input.request.documentId,
      documentVersion: input.request.documentVersion,
      settingsHash: input.request.settingsHash,
      ordinal: segment.original.ordinal,
    });

  const computeAlignment = async (
    audio: Buffer,
    segment: (typeof normalized)[number],
    audioKey: string,
  ) => runWhisperAlignmentFromAudioBuffer({
    audioBuffer: bufferToArrayBuffer(audio),
    text: segment.text,
    lang: effectiveSettings.language,
    cacheKey: audioKey,
  }).then((result) => {
    const first = result.alignments[0];
    return first ? { ...first, sentenceIndex: segment.original.ordinal } : null;
  }).catch(() => null);

  const persistSegmentMetadata = async (
    segment: (typeof normalized)[number],
    status: 'generating' | 'completed' | 'error',
    metadata: {
      audioKey: string;
      durationMs?: number | null;
      alignment?: Awaited<ReturnType<typeof computeAlignment>> | null;
      error?: unknown | null;
      leaseOwnerId?: string | null;
      updatedAt?: number;
    },
  ): Promise<void> => {
    if (input.cacheEpoch !== undefined && input.getCurrentCacheEpoch) {
      if (await input.getCurrentCacheEpoch() !== input.cacheEpoch) return;
    }
    const updatedAt = metadata.updatedAt ?? Date.now();
    await playbackStorage.artifacts.putSegmentMetadata({
      schemaVersion: 1,
      ...(input.cacheEpoch === undefined ? {} : { cacheEpoch: input.cacheEpoch }),
      status,
      storageUserId: input.request.storageUserId,
      documentId: input.request.documentId,
      documentVersion: input.request.documentVersion,
      readerType: input.request.readerType,
      settingsHash: input.request.settingsHash,
      settingsJson: input.request.settingsJson,
      ordinal: segment.original.ordinal,
      segmentKey: segment.segmentKey,
      textHash: segment.textHash,
      textLength: segment.text.length,
      audioKey: metadata.audioKey,
      audioFormat: 'mp3',
      durationMs: metadata.durationMs ?? null,
      alignment: metadata.alignment ?? null,
      error: metadata.error ?? null,
      leaseOwnerId: metadata.leaseOwnerId ?? null,
      leaseUpdatedAt: status === 'generating' ? updatedAt : null,
      updatedAt,
    });
  };

  const shouldContinueWrites = async (planOrdinal: number): Promise<boolean> => {
    if (input.onBeforeSegment && await input.onBeforeSegment(planOrdinal) === 'stop') return false;
    if (input.cacheEpoch !== undefined && input.getCurrentCacheEpoch) {
      if (await input.getCurrentCacheEpoch() !== input.cacheEpoch) return false;
    }
    return true;
  };

  const leaseOwnerId = [
    input.request.sessionId,
    input.request.generationExtent ?? 'window',
    input.request.generationRunId ?? 'initial',
  ].join(':');
  const leaseStaleMs = Math.max(GENERATION_LEASE_MIN_MS, input.synthesisTimeoutMs + GENERATION_LEASE_GRACE_MS);
  const minCacheEpoch = Math.max(0, Math.floor(Number(input.cacheEpoch ?? 0)));
  const freshSidecar = async (segment: (typeof normalized)[number]) => {
    const raw = await readSidecar(segment).catch(() => null);
    return raw && Math.max(0, Math.floor(Number(raw.cacheEpoch ?? 0))) >= minCacheEpoch ? raw : null;
  };
  const isFreshForeignLease = (
    sidecar: Awaited<ReturnType<typeof freshSidecar>>,
    audioKey: string,
    now = Date.now(),
  ): boolean => {
    if (!sidecar || sidecar.status !== 'generating' || sidecar.audioKey !== audioKey) return false;
    if (!sidecar.leaseOwnerId || sidecar.leaseOwnerId === leaseOwnerId) return false;
    const leaseUpdatedAt = Number(sidecar.leaseUpdatedAt ?? sidecar.updatedAt ?? 0);
    return Number.isFinite(leaseUpdatedAt) && now - leaseUpdatedAt < leaseStaleMs;
  };

  segmentLoop:
  for (const segment of normalized) {
    const planOrdinal = segment.original.ordinal;
    if (input.onBeforeSegment && await input.onBeforeSegment(planOrdinal) === 'stop') break;
    const audioKey = buildTtsPlaybackSegmentAudioKey({
      storagePrefix: input.s3Prefix,
      namespace: null,
      userId: input.request.storageUserId,
      documentId: input.request.documentId,
      documentVersion: input.request.documentVersion,
      settingsHash: input.request.settingsHash,
      audioContentHash: segment.audioContentHash,
    });

    let existing = await freshSidecar(segment);
    const audioExists = await input.audioObjectExists(audioKey).catch(() => false);
    if (audioExists) {
      if (!await shouldContinueWrites(planOrdinal)) break;
      let durationMs = existing?.status === 'completed' ? existing.durationMs : null;
      let alignment = existing?.alignment ?? null;
      const needsRebuild = existing?.status !== 'completed' || durationMs == null || !alignment;
      if (needsRebuild && input.readAudioObject) {
        try {
          const storedAudio = await input.readAudioObject(audioKey);
          if (durationMs == null) durationMs = await probeAudioDurationMsFromBuffer(storedAudio).catch(() => 0);
          if (!alignment) alignment = await computeAlignment(storedAudio, segment, audioKey);
        } catch {
          // A future generation pass retries this best-effort sidecar self-heal.
        }
      }
      if (needsRebuild && await shouldContinueWrites(planOrdinal)) {
        await persistSegmentMetadata(segment, 'completed', {
          audioKey,
          durationMs: Math.max(1, Number(durationMs ?? 1000)),
          alignment,
          updatedAt: Date.now(),
        }).catch(() => undefined);
      }
      await input.onSegmentCompleted?.(planOrdinal);
      continue;
    }

    if (existing?.status === 'error') {
      await input.onSegmentErrored?.(planOrdinal);
      continue;
    }

    while (isFreshForeignLease(existing, audioKey)) {
      if (!await shouldContinueWrites(planOrdinal)) break segmentLoop;
      await sleep(1_000);
      existing = await freshSidecar(segment);
      if (existing?.status === 'completed') {
        await input.onSegmentCompleted?.(planOrdinal);
        continue segmentLoop;
      }
      if (existing?.status === 'error') {
        await input.onSegmentErrored?.(planOrdinal);
        continue segmentLoop;
      }
    }

    if (!await shouldContinueWrites(planOrdinal)) break;
    await persistSegmentMetadata(segment, 'generating', { audioKey, leaseOwnerId, updatedAt: Date.now() })
      .catch(() => undefined);
    existing = await freshSidecar(segment);
    while (isFreshForeignLease(existing, audioKey)) {
      if (!await shouldContinueWrites(planOrdinal)) break segmentLoop;
      await sleep(1_000);
      existing = await freshSidecar(segment);
      if (existing?.status === 'completed') {
        await input.onSegmentCompleted?.(planOrdinal);
        continue segmentLoop;
      }
      if (existing?.status === 'error') {
        await input.onSegmentErrored?.(planOrdinal);
        continue segmentLoop;
      }
    }

    let lastError: unknown = null;
    let lastErrorInfo: SegmentErrorInfo | null = null;
    let completed = false;
    for (let attempt = 1; attempt <= SEGMENT_MAX_ATTEMPTS; attempt += 1) {
      try {
        const audioBuffer = await withAbortableTimeout(
          (signal) => generateTTSBuffer({
            text: segment.text,
            voice: effectiveSettings.voice,
            speed: effectiveSettings.nativeSpeed,
            format: 'mp3',
            model: effectiveSettings.ttsModel,
            instructions: effectiveSettings.ttsInstructions,
            language: effectiveSettings.language,
            provider: requestCreds.provider,
            apiKey: requestCreds.apiKey,
            baseUrl: requestCreds.baseUrl,
          }, signal, { ttsUpstreamTimeoutMs: input.synthesisTimeoutMs }),
          input.synthesisTimeoutMs,
          'tts playback segment synthesis',
        );
        if (!await shouldContinueWrites(planOrdinal)) return;
        await input.putAudioObject(audioKey, audioBuffer);
        if (!await shouldContinueWrites(planOrdinal)) {
          await input.deleteAudioObject?.(audioKey).catch(() => undefined);
          return;
        }
        const durationMs = await probeAudioDurationMsFromBuffer(audioBuffer).catch(() => 0);
        const alignment = await computeAlignment(audioBuffer, segment, audioKey);
        if (!await shouldContinueWrites(planOrdinal)) return;
        await persistSegmentMetadata(segment, 'completed', {
          audioKey,
          durationMs,
          alignment,
          updatedAt: Date.now(),
        }).catch(() => undefined);
        completed = true;
        break;
      } catch (error) {
        lastError = error;
        const classified = classifySegmentError(error);
        lastErrorInfo = classified.info;
        if (!classified.retryable) break;
      }
    }

    if (completed) {
      await input.onSegmentCompleted?.(planOrdinal);
      continue;
    }
    if (!await shouldContinueWrites(planOrdinal)) break;
    await persistSegmentMetadata(segment, 'error', {
      audioKey,
      error: lastErrorInfo ?? { message: lastError instanceof Error ? lastError.message : String(lastError) },
      updatedAt: Date.now(),
    }).catch(() => undefined);
    await input.onSegmentErrored?.(planOrdinal);
  }
}

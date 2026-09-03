import { generateTTSBuffer } from '@openreader/tts/generate';
import { resolveEffectiveTtsInstructions } from '@openreader/tts/instructions';
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
import { requireTtsSegmentTextHashSecret } from '../../infrastructure/credential-broker-config';
import type { TtsPlaybackStorage } from '../../playback/storage';
import { resolveTtsCredentialsFromBroker } from '../tts-credential-broker';
import { parseTtsSettings, type TtsPlaybackSegmentInput } from './plan';
import type { TtsPlaybackRequest } from './schemas';
import type { ModelDownloadProgressHandler } from '../../inference/model-download';

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
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortFromExternalSignal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternalSignal();
  else externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true });
  if (controller.signal.aborted) {
    throw controller.signal.reason instanceof Error
      ? controller.signal.reason
      : new DOMException('Aborted', 'AbortError');
  }
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
    externalSignal?.removeEventListener('abort', abortFromExternalSignal);
    controller.abort();
  }
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

export function leaseBelongsToPlaybackSession(
  ownerId: string,
  sessionId: string,
  sessionInstanceId: string,
): boolean {
  try {
    const parsed = JSON.parse(ownerId) as { sessionId?: unknown; sessionInstanceId?: unknown };
    return parsed.sessionId === sessionId && parsed.sessionInstanceId === sessionInstanceId;
  } catch {
    // Legacy owner ids cannot prove which incarnation wrote them. Treat them
    // as foreign until their bounded lease expires rather than overlapping
    // synthesis with a replaced session.
    return false;
  }
}

export async function generateExplicitTtsPlaybackSegments(input: {
  request: TtsPlaybackRequest;
  sessionInstanceId: string;
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
  signal?: AbortSignal;
  onBeforeSegment?: (planOrdinal: number) => Promise<'continue' | 'stop'>;
  onSynthesisSettled?: () => Promise<void>;
  onSegmentCompleted?: (planOrdinal: number) => Promise<void>;
  onSegmentErrored?: (planOrdinal: number) => Promise<void>;
  onModelDownloadProgress?: ModelDownloadProgressHandler;
}): Promise<void> {
  if (input.segments.length === 0 || input.signal?.aborted) return;

  const settings = parseTtsSettings(input.request.settingsJson);
  let requestCreds: Awaited<ReturnType<typeof resolveTtsCredentialsFromBroker>>;
  try {
    requestCreds = await resolveTtsCredentialsFromBroker(
      settings.providerRef,
      input.signal ? { signal: input.signal } : undefined,
    );
  } catch (error) {
    if (input.signal?.aborted) return;
    throw error;
  }
  const effectiveProviderRef = requestCreds.providerRef;
  const resolvedProviderType = requestCreds.providerType;
  const effectiveModel = resolveTtsModelForProvider({
    providerRef: effectiveProviderRef,
    providerType: resolvedProviderType,
    model: settings.ttsModel,
    sharedProviders: [{
      slug: requestCreds.providerRef,
      providerType: requestCreds.providerType,
      defaultModel: requestCreds.defaultModel,
      defaultInstructions: requestCreds.defaultInstructions,
    }],
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
      sharedDefaultInstructions: requestCreds.defaultInstructions,
    }) ?? '',
  };

  const secret = requireTtsSegmentTextHashSecret();
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
    onModelDownloadProgress: input.onModelDownloadProgress,
    shouldStart: () => shouldContinueWrites(segment.original.ordinal),
  }).then((result) => {
    const first = result.alignments[0];
    return first ? { ...first, sentenceIndex: segment.original.ordinal } : null;
  }).catch(() => null);

  type PendingAlignment = {
    segment: (typeof normalized)[number];
    audio: Buffer;
    audioKey: string;
    durationMs: number;
  };
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
    if (input.signal?.aborted) return false;
    if (input.onBeforeSegment && await input.onBeforeSegment(planOrdinal) === 'stop') return false;
    if (input.cacheEpoch !== undefined && input.getCurrentCacheEpoch) {
      if (await input.getCurrentCacheEpoch() !== input.cacheEpoch) return false;
    }
    return true;
  };

  const leaseOwnerId = JSON.stringify({
    sessionId: input.request.sessionId,
    sessionInstanceId: input.sessionInstanceId,
    generationExtent: input.request.generationExtent ?? 'window',
    generationRunId: input.request.generationRunId ?? 'initial',
  });
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
    // One canonical session incarnation has exactly one current generation
    // run. Its successor may immediately steal its predecessor's lease after a
    // seek or resume; a replacement incarnation must respect the old lease.
    if (leaseBelongsToPlaybackSession(
      sidecar.leaseOwnerId,
      input.request.sessionId,
      input.sessionInstanceId,
    )) return false;
    const leaseUpdatedAt = Number(sidecar.leaseUpdatedAt ?? sidecar.updatedAt ?? 0);
    return Number.isFinite(leaseUpdatedAt) && now - leaseUpdatedAt < leaseStaleMs;
  };

  // Keep synthesis audio-first, but do not postpone the first exact word
  // timing until the entire ahead window has been generated. A single ordered
  // alignment lane runs beside synthesis: the current segment becomes
  // playable immediately, its Whisper timing starts while the next segment is
  // synthesized, and only one alignment model invocation runs at a time.
  let alignmentQueue = Promise.resolve();
  let alignmentQueueStopped = false;
  const enqueueAlignment = (pending: PendingAlignment): void => {
    alignmentQueue = alignmentQueue.then(async () => {
      if (alignmentQueueStopped) return;
      const planOrdinal = pending.segment.original.ordinal;
      if (!await shouldContinueWrites(planOrdinal)) {
        alignmentQueueStopped = true;
        return;
      }
      const existing = await freshSidecar(pending.segment);
      if (existing?.status !== 'completed' || existing.alignment) return;
      const alignment = await computeAlignment(pending.audio, pending.segment, pending.audioKey);
      if (!alignment || !await shouldContinueWrites(planOrdinal)) return;
      await persistSegmentMetadata(pending.segment, 'completed', {
        audioKey: pending.audioKey,
        durationMs: pending.durationMs,
        alignment,
        updatedAt: Date.now(),
      }).catch(() => undefined);
      // Emit another snapshot so a live client replaces provisional timing
      // without waiting for a new playback session.
      await input.onSegmentCompleted?.(planOrdinal);
    });
  };

  segmentLoop:
  for (const segment of normalized) {
    if (input.signal?.aborted) break;
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
      const alignment = existing?.alignment ?? null;
      const needsRebuild = existing?.status !== 'completed' || durationMs == null || !alignment;
      let storedAudio: Buffer | null = null;
      if (needsRebuild && input.readAudioObject) {
        try {
          storedAudio = await input.readAudioObject(audioKey);
          if (durationMs == null) durationMs = await probeAudioDurationMsFromBuffer(storedAudio).catch(() => 0);
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
      if (!alignment && storedAudio) {
        enqueueAlignment({
          segment,
          audio: storedAudio,
          audioKey,
          durationMs: Math.max(1, Number(durationMs ?? 1000)),
        });
      }
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
    let completedAlignment: PendingAlignment | null = null;
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
            provider: requestCreds.providerType,
            apiKey: requestCreds.apiKey,
            baseUrl: requestCreds.baseUrl ?? undefined,
          }, signal, { ttsUpstreamTimeoutMs: input.synthesisTimeoutMs }),
          input.synthesisTimeoutMs,
          'tts playback segment synthesis',
          input.signal,
        );
        if (!await shouldContinueWrites(planOrdinal)) return;
        await input.putAudioObject(audioKey, audioBuffer);
        if (!await shouldContinueWrites(planOrdinal)) {
          await input.deleteAudioObject?.(audioKey).catch(() => undefined);
          return;
        }
        const durationMs = await probeAudioDurationMsFromBuffer(audioBuffer).catch(() => 0);
        if (!await shouldContinueWrites(planOrdinal)) return;
        await persistSegmentMetadata(segment, 'completed', {
          audioKey,
          durationMs,
          alignment: null,
          updatedAt: Date.now(),
        }).catch(() => undefined);
        completedAlignment = {
          segment,
          audio: audioBuffer,
          audioKey,
          durationMs: Math.max(1, durationMs),
        };
        completed = true;
        break;
      } catch (error) {
        if (input.signal?.aborted) return;
        lastError = error;
        const classified = classifySegmentError(error);
        lastErrorInfo = classified.info;
        if (!classified.retryable) break;
      }
    }

    if (completed) {
      await input.onSegmentCompleted?.(planOrdinal);
      if (completedAlignment) enqueueAlignment(completedAlignment);
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

  // Audio production and best-effort exact alignment have different urgency.
  // Tell the session controller that synthesis has reached its current boundary
  // before waiting for the ordered alignment lane to drain, so an active reader
  // can refill without being blocked by cold or CPU-constrained Whisper work.
  await input.onSynthesisSettled?.();

  // Keep the job alive until queued best-effort timing has either completed or
  // observed that this playback run was paused/superseded.
  await alignmentQueue;
}

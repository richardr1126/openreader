import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { ttsSegmentEntries, ttsSegmentVariants } from '@/db/schema';
import { isS3Configured, getS3Config } from '@/lib/server/storage/s3';
import { generateTTSBuffer } from '@/lib/server/tts/generate';
import {
  getTtsSegmentAudioObject,
  putTtsSegmentAudioObject,
} from '@/lib/server/tts/segments-blobstore';
import {
  buildTtsSegmentAudioKey,
  buildTtsSegmentEntryId,
  buildTtsSegmentId,
  buildTtsSegmentSettingsHash,
  buildTtsSegmentSettingsJson,
  buildTtsSegmentTextHash,
  locatorFingerprint,
  normalizeLocator,
  normalizeSegmentText,
  projectSegmentLocator,
  probeAudioDurationMsFromBuffer,
} from '@/lib/server/tts/segments';
import { isBuiltInTtsProviderId, isTtsProviderType } from '@/lib/shared/tts-provider-catalog';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import { rateLimiter, resolveRateLimitThresholds } from '@/lib/server/rate-limit/rate-limiter';
import { resolveTtsCredentials } from '@/lib/server/admin/resolve-credentials';
import { resolveEffectiveTtsInstructions } from '@/lib/server/admin/tts-instructions';
import { getClientIp } from '@/lib/server/rate-limit/request-ip';
import { getOrCreateDeviceId, setDeviceIdCookie } from '@/lib/server/rate-limit/device-id';
import { buildDailyQuotaExceededResponse } from '@/lib/server/rate-limit/problem-response';
import { getUpstreamRetryAfterSeconds, getUpstreamStatus } from '@/lib/server/tts/upstream-response';
import { userWhisperAlignJob } from '@/lib/server/jobs/user-whisper-align-job';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { resolveTtsModelForProvider } from '@/lib/shared/tts-provider-policy';
import { resolveSegmentAudioUrls } from '@/lib/server/tts/segment-audio-urls';
import { createRequestLogger, errorToLog } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import type {
  TTSSegmentInput,
  TTSSegmentManifestItem,
  TTSSegmentSettings,
  TTSSegmentsEnsureRequest,
} from '@/types/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const GENERATING_STALE_MS = 360_000;

function attachDeviceIdCookie(response: NextResponse, deviceId: string | null, didCreate: boolean) {
  if (didCreate && deviceId) {
    setDeviceIdCookie(response, deviceId);
  }
}

function parseSettings(value: unknown): TTSSegmentSettings | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.providerRef !== 'string') return null;
  if (!isTtsProviderType(rec.providerType)) return null;
  if (typeof rec.ttsModel !== 'string') return null;
  if (typeof rec.voice !== 'string') return null;
  if (!Number.isFinite(Number(rec.nativeSpeed))) return null;
  if (rec.ttsInstructions !== undefined && typeof rec.ttsInstructions !== 'string') return null;

  return {
    providerRef: rec.providerRef,
    providerType: rec.providerType,
    ttsModel: rec.ttsModel,
    voice: rec.voice,
    nativeSpeed: Number(rec.nativeSpeed),
    ...(typeof rec.ttsInstructions === 'string' ? { ttsInstructions: rec.ttsInstructions } : {}),
  };
}

function parseSegments(value: unknown): TTSSegmentInput[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parsed: TTSSegmentInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if (!Number.isInteger(rec.segmentIndex) || Number(rec.segmentIndex) < 0) return null;
    if (typeof rec.text !== 'string') return null;
    parsed.push({
      segmentIndex: Number(rec.segmentIndex),
      ...(typeof rec.segmentKey === 'string' && rec.segmentKey.trim()
        ? { segmentKey: rec.segmentKey.trim() }
        : {}),
      text: rec.text,
      ...(rec.locator && typeof rec.locator === 'object' ? { locator: rec.locator as TTSSegmentInput['locator'] } : {}),
    });
  }
  return parsed;
}

function parseBody(value: unknown): TTSSegmentsEnsureRequest | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.documentId !== 'string' || !rec.documentId.trim()) return null;
  const settings = parseSettings(rec.settings);
  const segments = parseSegments(rec.segments);
  if (!settings || !segments) return null;

  return {
    documentId: rec.documentId.trim().toLowerCase(),
    settings,
    segments,
  };
}

function s3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'TTS segments storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
}

function textHmacSecret(): string {
  return process.env.AUTH_SECRET?.trim()
    || 'openreader-default-tts-segment-secret';
}

function isAbortLikeError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  if (!message) return false;
  return /abort/i.test(message);
}

async function deleteEntryIfUnused(userId: string, segmentEntryId: string): Promise<void> {
  const stillReferenced = await db
    .select({ segmentId: ttsSegmentVariants.segmentId })
    .from(ttsSegmentVariants)
    .where(and(
      eq(ttsSegmentVariants.userId, userId),
      eq(ttsSegmentVariants.segmentEntryId, segmentEntryId),
    ))
    .limit(1);

  if (stillReferenced.length > 0) return;

  await db
    .delete(ttsSegmentEntries)
    .where(and(
      eq(ttsSegmentEntries.userId, userId),
      eq(ttsSegmentEntries.segmentEntryId, segmentEntryId),
    ));
}

export async function POST(request: NextRequest) {
  let didCreateDeviceIdCookie = false;
  let deviceIdToSet: string | null = null;
  const { logger, requestId } = createRequestLogger({
    route: '/api/tts/segments/ensure',
    request,
  });
  const requestStartedAt = Date.now();
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const parsed = parseBody(await request.json().catch(() => null));
    if (!parsed) {
      return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
    }

    const scope = await resolveSegmentDocumentScope(request, parsed.documentId);
    if (scope instanceof Response) return scope;
    const runtimeConfig = await getResolvedRuntimeConfig();
    const ttsRateLimitEnabled = !runtimeConfig.disableTtsRateLimit;
    const limits = resolveRateLimitThresholds({
      anonymous: runtimeConfig.ttsDailyLimitAnonymous,
      authenticated: runtimeConfig.ttsDailyLimitAuthenticated,
      ipAnonymous: runtimeConfig.ttsIpDailyLimitAnonymous,
      ipAuthenticated: runtimeConfig.ttsIpDailyLimitAuthenticated,
    });
    const requestCreds = await resolveTtsCredentials({
      providerHeader: parsed.settings.providerRef,
      apiKeyHeader: request.headers.get('x-openai-key'),
      baseUrlHeader: request.headers.get('x-openai-base-url'),
      fallbackProvider: runtimeConfig.defaultTtsProvider,
      restrictUserApiKeys: runtimeConfig.restrictUserApiKeys,
    });
    if ('error' in requestCreds) {
      const status = requestCreds.error === 'no_shared_provider_configured' ? 503 : 404;
      return NextResponse.json(
        {
          error: requestCreds.error === 'no_shared_provider_configured'
            ? 'User API keys are restricted and no shared provider is configured.'
            : `Unknown or disabled TTS provider: ${requestCreds.slug}`,
        },
        { status },
      );
    }

    // Normalize request settings to the effective generation settings so cache
    // keys and persisted metadata match what we actually synthesize.
    const effectiveProviderRef = requestCreds.adminRecord?.slug || parsed.settings.providerRef;
    const effectiveModel = resolveTtsModelForProvider({
      providerRef: effectiveProviderRef,
      providerType: isBuiltInTtsProviderId(requestCreds.provider) ? requestCreds.provider : 'unknown',
      model: parsed.settings.ttsModel,
      sharedProviders: requestCreds.adminRecord ? [requestCreds.adminRecord] : [],
      fallbackProviderRef: runtimeConfig.defaultTtsProvider,
      showAllProviderModels: runtimeConfig.showAllProviderModels,
    });
    const effectiveInstructions = resolveEffectiveTtsInstructions({
      model: effectiveModel,
      requestInstructions: parsed.settings.ttsInstructions,
      sharedDefaultInstructions: requestCreds.adminRecord?.defaultInstructions,
    }) ?? '';
    const resolvedProviderType = isBuiltInTtsProviderId(requestCreds.provider)
      ? requestCreds.provider
      : 'unknown';
    const effectiveSettings: TTSSegmentSettings = {
      ...parsed.settings,
      providerRef: effectiveProviderRef,
      providerType: resolvedProviderType,
      ttsModel: effectiveModel,
      ttsInstructions: effectiveInstructions,
    };

    const settingsHash = buildTtsSegmentSettingsHash(effectiveSettings);
    const settingsJson = buildTtsSegmentSettingsJson(effectiveSettings);
    const nowMs = Date.now();
    const storagePrefix = getS3Config().prefix;
    const secret = textHmacSecret();
    const shouldRunWhisperAlignment = !scope.testNamespace;

    let invalidLocatorIndex = -1;
    const normalized = parsed.segments
      .map((segment, index) => {
        const text = normalizeSegmentText(segment.text);
        if (!text) return null;
        const locator = normalizeLocator(segment.locator);
        if (!locator) {
          invalidLocatorIndex = index;
          return null;
        }
        const locatorHash = locatorFingerprint(locator);
        const segmentId = buildTtsSegmentId({
          documentId: parsed.documentId,
          documentVersion: scope.documentVersion,
          settingsHash,
          segmentIndex: segment.segmentIndex,
          segmentKey: segment.segmentKey,
          normalizedText: text,
          locatorFingerprint: locatorHash,
        });

        return {
          original: segment,
          text,
          locator,
          segmentId,
          textHash: buildTtsSegmentTextHash(text, secret),
        };
      })
      .filter((value): value is NonNullable<typeof value> => Boolean(value));

    if (invalidLocatorIndex >= 0) {
      return NextResponse.json(
        { error: `Invalid or unsupported segment locator at index ${invalidLocatorIndex}` },
        { status: 400 },
      );
    }

    if (normalized.length === 0) {
      return NextResponse.json({ error: 'No valid non-empty segments provided' }, { status: 400 });
    }

    const ids = normalized.map((segment) => segment.segmentId);
    const rows = (await db
      .select()
      .from(ttsSegmentVariants)
      .where(and(
        eq(ttsSegmentVariants.userId, scope.storageUserId),
        inArray(ttsSegmentVariants.segmentId, ids),
      ))) as Array<{
      segmentId: string;
      userId: string;
      segmentEntryId: string;
      settingsHash: string;
      settingsJson: unknown;
      audioKey: string | null;
      audioFormat: string;
      durationMs: number | null;
      alignmentJson: string | null;
      status: string;
      error: string | null;
      createdAt: number | null;
      updatedAt: number | null;
    }>;

    const existingById = new Map(rows.map((row) => [row.segmentId, row]));
    const manifest: TTSSegmentManifestItem[] = [];
    const upsertSegmentEntry = async (input: {
      segmentEntryId: string;
      segmentIndex: number;
      segmentKey: string | null;
      locatorProjection: ReturnType<typeof projectSegmentLocator>;
      textHash: string;
      textLength: number;
    }): Promise<void> => {
      await db
        .insert(ttsSegmentEntries)
        .values({
          segmentEntryId: input.segmentEntryId,
          userId: scope.storageUserId,
          documentId: parsed.documentId,
          readerType: scope.readerType,
          documentVersion: scope.documentVersion,
          segmentIndex: input.segmentIndex,
          segmentKey: input.segmentKey,
          ...input.locatorProjection,
          textHash: input.textHash,
          textLength: input.textLength,
          updatedAt: nowMs,
        })
        .onConflictDoUpdate({
          target: [ttsSegmentEntries.segmentEntryId, ttsSegmentEntries.userId],
          set: {
            documentId: parsed.documentId,
            readerType: scope.readerType,
            documentVersion: scope.documentVersion,
            segmentIndex: input.segmentIndex,
            segmentKey: input.segmentKey,
            ...input.locatorProjection,
            textHash: input.textHash,
            textLength: input.textLength,
            updatedAt: nowMs,
          },
        });
    };

    for (const segment of normalized) {
      if (request.signal.aborted) {
        logger.info({
          event: 'tts.segments.ensure.request_aborted',
          requestId,
          documentId: parsed.documentId,
          completedSoFar: manifest.length,
          totalRequested: normalized.length,
        }, 'TTS segment ensure request aborted');
        break;
      }

      const segmentStartedAt = Date.now();
      const stageTimings: Record<string, number> = {};
      let failedStage = 'unknown';
      const locatorProjection = projectSegmentLocator(segment.locator);
      const segmentKeyForRow = typeof segment.original.segmentKey === 'string' && segment.original.segmentKey.trim()
        ? segment.original.segmentKey.trim()
        : null;
      const segmentEntryId = buildTtsSegmentEntryId({
        documentId: parsed.documentId,
        documentVersion: scope.documentVersion,
        segmentIndex: segment.original.segmentIndex,
        segmentKey: segmentKeyForRow,
        locatorIdentityKey: locatorProjection.locatorIdentityKey,
        textHash: segment.textHash,
      });

      const existing = existingById.get(segment.segmentId);
      const movedFromEntryId = existing && existing.segmentEntryId !== segmentEntryId
        ? existing.segmentEntryId
        : null;

      if (existing?.status === 'completed' && existing.audioKey) {
        await upsertSegmentEntry({
          segmentEntryId,
          segmentIndex: segment.original.segmentIndex,
          segmentKey: segmentKeyForRow,
          locatorProjection,
          textHash: segment.textHash,
          textLength: segment.text.length,
        });

        if (movedFromEntryId) {
          await db
            .update(ttsSegmentVariants)
            .set({
              segmentEntryId,
              settingsJson,
              updatedAt: nowMs,
            })
            .where(and(
              eq(ttsSegmentVariants.segmentId, segment.segmentId),
              eq(ttsSegmentVariants.userId, scope.storageUserId),
            ));
          await deleteEntryIfUnused(scope.storageUserId, movedFromEntryId);
        }

        let alignment = existing.alignmentJson
          ? (JSON.parse(existing.alignmentJson) as TTSSegmentManifestItem['alignment'])
          : null;
        const locator = segment.locator;

        // Self-heal transient Whisper failures: if audio exists but alignment was
        // previously unavailable, retry alignment using the current segment text.
        if (shouldRunWhisperAlignment && !alignment && !request.signal.aborted) {
          try {
            const alignStartedAt = Date.now();
            alignment = await userWhisperAlignJob({
              audioObjectKey: existing.audioKey,
              text: segment.text,
              sentenceIndex: segment.original.segmentIndex,
            });
            stageTimings.selfHealAlignMs = Date.now() - alignStartedAt;

            if (alignment) {
              await db
                .update(ttsSegmentVariants)
                .set({
                  alignmentJson: JSON.stringify(alignment),
                  updatedAt: Date.now(),
                })
                .where(and(
                  eq(ttsSegmentVariants.segmentId, segment.segmentId),
                  eq(ttsSegmentVariants.userId, scope.storageUserId),
                ));
            }
          } catch (alignError) {
            const aborted = isAbortLikeError(alignError) || request.signal.aborted;
            const level = aborted ? 'info' : 'warn';
            logger[level]({
              event: 'tts.segments.ensure.self_heal_alignment_unavailable',
              requestId,
              documentId: parsed.documentId,
              segmentId: segment.segmentId,
              aborted,
              ...(aborted ? {} : { degraded: true }),
              step: 'whisper_align',
              error: errorToLog(alignError),
            }, 'Self-heal alignment unavailable');
            alignment = null;
          }
        }

        const audioUrls = await resolveSegmentAudioUrls({
          documentId: parsed.documentId,
          segmentId: segment.segmentId,
          audioKey: existing.audioKey,
        });

        manifest.push({
          segmentId: segment.segmentId,
          segmentIndex: segment.original.segmentIndex,
          segmentKey: segmentKeyForRow,
          ...audioUrls,
          durationMs: existing.durationMs ?? 0,
          alignment,
          locator,
          status: 'completed',
        });
        continue;
      }

      const audioKey = existing?.audioKey || buildTtsSegmentAudioKey({
        storagePrefix,
        namespace: scope.testNamespace,
        userId: scope.storageUserId,
        documentId: parsed.documentId,
        documentVersion: scope.documentVersion,
        settingsHash,
        segmentId: segment.segmentId,
      });

      if (ttsRateLimitEnabled) {
        const charCount = segment.text.length;
        const ip = getClientIp(request);
        const device = scope.isAnonymousUser ? getOrCreateDeviceId(request) : null;
        if (device?.didCreate) {
          didCreateDeviceIdCookie = true;
          deviceIdToSet = device.deviceId;
        }

        const rateLimitResult = await rateLimiter.checkAndIncrementLimit(
          { id: scope.userId, isAnonymous: scope.isAnonymousUser },
          charCount,
          {
            deviceId: device?.deviceId ?? null,
            ip,
          },
          {
            enabled: ttsRateLimitEnabled,
            limits,
          },
        );

        if (!rateLimitResult.allowed) {
          const response = buildDailyQuotaExceededResponse({
            rateLimitResult,
            isAnonymousUser: scope.isAnonymousUser,
            pathname: request.nextUrl.pathname,
            anonymousLimit: limits.anonymous,
            authenticatedLimit: limits.authenticated,
          });
          attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
          return response;
        }
      }

      await upsertSegmentEntry({
        segmentEntryId,
        segmentIndex: segment.original.segmentIndex,
        segmentKey: segmentKeyForRow,
        locatorProjection,
        textHash: segment.textHash,
        textLength: segment.text.length,
      });

      await db
        .insert(ttsSegmentVariants)
        .values({
          segmentId: segment.segmentId,
          userId: scope.storageUserId,
          segmentEntryId,
          settingsHash,
          settingsJson,
          audioKey,
          audioFormat: 'mp3',
          status: 'pending',
          error: null,
          updatedAt: nowMs,
        })
        .onConflictDoUpdate({
          target: [ttsSegmentVariants.segmentId, ttsSegmentVariants.userId],
          set: {
            segmentEntryId,
            settingsHash,
            settingsJson,
            audioKey,
            audioFormat: 'mp3',
            status: 'pending',
            error: null,
            updatedAt: nowMs,
          },
        });

      if (movedFromEntryId) {
        await deleteEntryIfUnused(scope.storageUserId, movedFromEntryId);
      }

      const [currentVariant] = await db
        .select({
          status: ttsSegmentVariants.status,
          updatedAt: ttsSegmentVariants.updatedAt,
          error: ttsSegmentVariants.error,
          audioKey: ttsSegmentVariants.audioKey,
        })
        .from(ttsSegmentVariants)
        .where(and(
          eq(ttsSegmentVariants.segmentId, segment.segmentId),
          eq(ttsSegmentVariants.userId, scope.storageUserId),
        ))
        .limit(1);

      if (!currentVariant) {
        manifest.push({
          segmentId: segment.segmentId,
          segmentIndex: segment.original.segmentIndex,
          segmentKey: segmentKeyForRow,
          audioPresignUrl: null,
          audioFallbackUrl: null,
          durationMs: 0,
          alignment: null,
          locator: segment.locator,
          status: 'pending',
        });
        continue;
      }

      if (currentVariant.status === 'generating') {
        const lastUpdatedAt = Number(currentVariant.updatedAt ?? 0);
        const isFresh = lastUpdatedAt > 0 && (Date.now() - lastUpdatedAt) < GENERATING_STALE_MS;
        if (isFresh) {
          manifest.push({
            segmentId: segment.segmentId,
            segmentIndex: segment.original.segmentIndex,
            segmentKey: segmentKeyForRow,
            audioPresignUrl: null,
            audioFallbackUrl: null,
            durationMs: 0,
            alignment: null,
            locator: segment.locator,
            status: 'pending',
          });
          continue;
        }
      }

      if (currentVariant.status === 'pending' || currentVariant.status === 'error' || currentVariant.status === 'generating') {
        const expectedUpdatedAt = Number(currentVariant.updatedAt ?? 0);
        const [claim] = await db
          .update(ttsSegmentVariants)
          .set({
            status: 'generating',
            error: null,
            updatedAt: Date.now(),
          })
          .where(and(
            eq(ttsSegmentVariants.segmentId, segment.segmentId),
            eq(ttsSegmentVariants.userId, scope.storageUserId),
            eq(ttsSegmentVariants.status, currentVariant.status),
            eq(ttsSegmentVariants.updatedAt, expectedUpdatedAt),
          ))
          .returning({
            status: ttsSegmentVariants.status,
          });

        if (!claim) {
          manifest.push({
            segmentId: segment.segmentId,
            segmentIndex: segment.original.segmentIndex,
            segmentKey: segmentKeyForRow,
            audioPresignUrl: null,
            audioFallbackUrl: null,
            durationMs: 0,
            alignment: null,
            locator: segment.locator,
            status: 'pending',
          });
          continue;
        }
      }

      try {
        failedStage = 'tts.generate';
        const ttsStartedAt = Date.now();
        const ttsBuffer = await generateTTSBuffer({
          text: segment.text,
          voice: effectiveSettings.voice,
          speed: effectiveSettings.nativeSpeed,
          format: 'mp3',
          model: effectiveSettings.ttsModel,
          instructions: effectiveSettings.ttsInstructions,
          provider: requestCreds.provider,
          apiKey: requestCreds.apiKey || 'none',
          baseUrl: requestCreds.baseUrl,
          testNamespace: scope.testNamespace,
        }, request.signal, {
          ttsCacheMaxSizeBytes: runtimeConfig.ttsCacheMaxSizeBytes,
          ttsCacheTtlMs: runtimeConfig.ttsCacheTtlMs,
          ttsUpstreamMaxRetries: runtimeConfig.ttsUpstreamMaxRetries,
          ttsUpstreamTimeoutMs: runtimeConfig.ttsUpstreamTimeoutMs,
        });
        stageTimings.generateTtsMs = Date.now() - ttsStartedAt;

        failedStage = 's3.put_audio';
        const putStartedAt = Date.now();
        await putTtsSegmentAudioObject(audioKey, ttsBuffer);
        stageTimings.putAudioMs = Date.now() - putStartedAt;

        let persistedBuffer = ttsBuffer;
        if (persistedBuffer.byteLength === 0) {
          failedStage = 's3.get_audio_after_empty_put';
          const getStartedAt = Date.now();
          persistedBuffer = await getTtsSegmentAudioObject(audioKey);
          stageTimings.getAudioAfterEmptyPutMs = Date.now() - getStartedAt;
        }

        failedStage = 'audio.probe_duration';
        const probeStartedAt = Date.now();
        const durationMs = await probeAudioDurationMsFromBuffer(persistedBuffer, request.signal);
        stageTimings.probeDurationMs = Date.now() - probeStartedAt;
        let alignment: TTSSegmentManifestItem['alignment'] = null;
        if (shouldRunWhisperAlignment && !request.signal.aborted) {
          try {
            failedStage = 'whisper.align';
            const alignStartedAt = Date.now();
            alignment = await userWhisperAlignJob({
              audioObjectKey: audioKey,
              text: segment.text,
              sentenceIndex: segment.original.segmentIndex,
            });
            stageTimings.whisperAlignMs = Date.now() - alignStartedAt;
          } catch (alignError) {
            const aborted = isAbortLikeError(alignError) || request.signal.aborted;
            const level = aborted ? 'info' : 'warn';
            logger[level]({
              event: 'tts.segments.ensure.alignment_unavailable',
              requestId,
              documentId: parsed.documentId,
              segmentId: segment.segmentId,
              aborted,
              ...(aborted ? {} : { degraded: true }),
              step: 'whisper_align',
              error: errorToLog(alignError),
            }, 'Alignment unavailable');
            alignment = null;
          }
        }

        failedStage = 'db.mark_completed';
        const markCompletedStartedAt = Date.now();
        await db
          .update(ttsSegmentVariants)
          .set({
            durationMs,
            alignmentJson: alignment ? JSON.stringify(alignment) : null,
            status: 'completed',
            error: null,
            updatedAt: Date.now(),
          })
          .where(and(
            eq(ttsSegmentVariants.segmentId, segment.segmentId),
            eq(ttsSegmentVariants.userId, scope.storageUserId),
          ));
        stageTimings.markCompletedMs = Date.now() - markCompletedStartedAt;

        failedStage = 'resolve.audio_urls';
        const resolveUrlsStartedAt = Date.now();
        const audioUrls = await resolveSegmentAudioUrls({
          documentId: parsed.documentId,
          segmentId: segment.segmentId,
          audioKey,
        });
        stageTimings.resolveAudioUrlsMs = Date.now() - resolveUrlsStartedAt;

        manifest.push({
          segmentId: segment.segmentId,
          segmentIndex: segment.original.segmentIndex,
          segmentKey: segmentKeyForRow,
          ...audioUrls,
          durationMs,
          alignment,
          locator: segment.locator,
          status: 'completed',
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to generate segment';
        const aborted = isAbortLikeError(error);
        const upstreamStatus = getUpstreamStatus(error);
        const retryAfterSeconds = upstreamStatus === 429
          ? getUpstreamRetryAfterSeconds(error)
          : undefined;
        const failureCode = upstreamStatus === 429
          ? 'UPSTREAM_RATE_LIMIT'
          : upstreamStatus && upstreamStatus >= 500
            ? 'UPSTREAM_TTS_ERROR'
            : 'TTS_SEGMENT_GENERATION_FAILED';
        if (aborted) {
          logger.info({
            event: 'tts.segments.ensure.segment_aborted',
            requestId,
            documentId: parsed.documentId,
            segmentId: segment.segmentId,
            failedStage,
            elapsedMs: Date.now() - segmentStartedAt,
            stageTimings,
            aborted: true,
            error: errorToLog(error),
            completedSoFar: manifest.length,
            totalRequested: normalized.length,
          }, 'Stopping segment ensure after abort');
        } else {
          logger.error({
            event: 'tts.segments.ensure.segment_failed',
            requestId,
            documentId: parsed.documentId,
            segmentId: segment.segmentId,
            failedStage,
            elapsedMs: Date.now() - segmentStartedAt,
            stageTimings,
            aborted: false,
            upstreamStatus,
            retryAfterSeconds,
            error: errorToLog(error),
          }, 'TTS segment generation failed');
        }
        await db
          .update(ttsSegmentVariants)
          .set({
            status: aborted ? 'pending' : 'error',
            error: aborted ? null : (
              upstreamStatus
                ? `${failureCode}${retryAfterSeconds ? ` (retry after ${retryAfterSeconds}s)` : ''}: ${errorMessage}`
                : errorMessage
            ),
            updatedAt: Date.now(),
          })
          .where(and(
            eq(ttsSegmentVariants.segmentId, segment.segmentId),
            eq(ttsSegmentVariants.userId, scope.storageUserId),
          ));

        manifest.push({
          segmentId: segment.segmentId,
          segmentIndex: segment.original.segmentIndex,
          segmentKey: segmentKeyForRow,
          audioPresignUrl: null,
          audioFallbackUrl: null,
          durationMs: 0,
          alignment: null,
          locator: segment.locator,
          status: aborted ? 'pending' : 'error',
          error: aborted
            ? null
            : {
              code: failureCode,
              detail: errorMessage,
              ...(typeof upstreamStatus === 'number' ? { upstreamStatus } : {}),
              ...(typeof retryAfterSeconds === 'number' ? { retryAfterSeconds } : {}),
          },
        });

        if (aborted || request.signal.aborted) {
          break;
        }
      }
    }

    const completedCount = manifest.filter((s) => s.status === 'completed').length;
    const pendingCount = manifest.filter((s) => s.status === 'pending').length;
    const errorItems = manifest.filter((s) => s.status === 'error');
    if (errorItems.length > 0) {
      logger.error({
        event: 'tts.segments.ensure.partial_result',
        requestId,
        documentId: parsed.documentId,
        total: manifest.length,
        completedCount,
        pendingCount,
        errorCount: errorItems.length,
        elapsedMs: Date.now() - requestStartedAt,
        error: {
          name: 'PartialSegmentFailure',
          message: `TTS segment ensure completed with ${errorItems.length} segment errors`,
        },
        errors: errorItems.slice(0, 5).map((item) => ({
          segmentId: item.segmentId,
          code: item.error?.code ?? null,
          detail: item.error?.detail ?? null,
          upstreamStatus: item.error?.upstreamStatus ?? null,
          retryAfterSeconds: item.error?.retryAfterSeconds ?? null,
        })),
      }, 'TTS segment ensure completed with partial errors');
    }

    const response = NextResponse.json({
      documentId: parsed.documentId,
      segments: manifest,
    });
    attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
    return response;
  } catch (error) {
    const response = errorResponse(error, {
      logger,
      event: 'tts.segments.ensure.route_failed',
      msg: 'TTS segments ensure route failed',
      apiErrorMessage: 'Failed to ensure TTS segments',
      normalize: { code: 'TTS_SEGMENTS_ENSURE_ROUTE_FAILED', errorClass: 'upstream' },
    });
    attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
    return response;
  }
}

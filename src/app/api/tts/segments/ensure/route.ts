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
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import { rateLimiter, RATE_LIMITS, isTtsRateLimitEnabled } from '@/lib/server/rate-limit/rate-limiter';
import { getClientIp } from '@/lib/server/rate-limit/request-ip';
import { getOrCreateDeviceId, setDeviceIdCookie } from '@/lib/server/rate-limit/device-id';
import { alignAudioWithText } from '@/lib/server/whisper/alignment';
import type {
  TTSSegmentInput,
  TTSSegmentManifestItem,
  TTSSegmentSettings,
  TTSSegmentsEnsureRequest,
} from '@/types/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function attachDeviceIdCookie(response: NextResponse, deviceId: string | null, didCreate: boolean) {
  if (didCreate && deviceId) {
    setDeviceIdCookie(response, deviceId);
  }
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

function parseSettings(value: unknown): TTSSegmentSettings | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.ttsProvider !== 'string') return null;
  if (typeof rec.ttsModel !== 'string') return null;
  if (typeof rec.voice !== 'string') return null;
  if (!Number.isFinite(Number(rec.nativeSpeed))) return null;
  if (rec.ttsInstructions !== undefined && typeof rec.ttsInstructions !== 'string') return null;

  return {
    ttsProvider: rec.ttsProvider,
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

function buildSegmentAudioUrls(documentId: string, segmentId: string): {
  audioPresignUrl: string;
  audioFallbackUrl: string;
} {
  const encodedDocumentId = encodeURIComponent(documentId);
  const encodedSegmentId = encodeURIComponent(segmentId);
  return {
    audioPresignUrl: `/api/tts/segments/audio/presign?documentId=${encodedDocumentId}&segmentId=${encodedSegmentId}`,
    audioFallbackUrl: `/api/tts/segments/audio/fallback?documentId=${encodedDocumentId}&segmentId=${encodedSegmentId}`,
  };
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
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const parsed = parseBody(await request.json().catch(() => null));
    if (!parsed) {
      return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
    }

    const scope = await resolveSegmentDocumentScope(request, parsed.documentId);
    if (scope instanceof Response) return scope;

    const settingsHash = buildTtsSegmentSettingsHash(parsed.settings);
    const settingsJson = buildTtsSegmentSettingsJson(parsed.settings);
    const nowMs = Date.now();
    const storagePrefix = getS3Config().prefix;
    const secret = textHmacSecret();

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

    for (const segment of normalized) {
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

      await db
        .insert(ttsSegmentEntries)
        .values({
          segmentEntryId,
          userId: scope.storageUserId,
          documentId: parsed.documentId,
          readerType: scope.readerType,
          documentVersion: scope.documentVersion,
          segmentIndex: segment.original.segmentIndex,
          segmentKey: segmentKeyForRow,
          ...locatorProjection,
          textHash: segment.textHash,
          textLength: segment.text.length,
          updatedAt: nowMs,
        })
        .onConflictDoUpdate({
          target: [ttsSegmentEntries.segmentEntryId, ttsSegmentEntries.userId],
          set: {
            documentId: parsed.documentId,
            readerType: scope.readerType,
            documentVersion: scope.documentVersion,
            segmentIndex: segment.original.segmentIndex,
            segmentKey: segmentKeyForRow,
            ...locatorProjection,
            textHash: segment.textHash,
            textLength: segment.text.length,
            updatedAt: nowMs,
          },
        });

      const existing = existingById.get(segment.segmentId);
      const movedFromEntryId = existing && existing.segmentEntryId !== segmentEntryId
        ? existing.segmentEntryId
        : null;

      if (existing?.status === 'completed' && existing.audioKey) {
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
        if (!alignment) {
          try {
            const audioBuffer = await getTtsSegmentAudioObject(existing.audioKey);
            const whisperBytes = Uint8Array.from(audioBuffer);
            const aligned = await alignAudioWithText(
              whisperBytes.buffer,
              segment.text,
              undefined,
              { engine: 'whisper.cpp' },
            );
            alignment = aligned[0] ? { ...aligned[0], sentenceIndex: segment.original.segmentIndex } : null;

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
            console.warn('Whisper alignment still unavailable for completed segment; continuing without word highlights.', {
              segmentId: segment.segmentId,
              error: alignError instanceof Error ? alignError.message : String(alignError),
            });
            alignment = null;
          }
        }

        manifest.push({
          segmentId: segment.segmentId,
          segmentIndex: segment.original.segmentIndex,
          segmentKey: segmentKeyForRow,
          ...buildSegmentAudioUrls(parsed.documentId, segment.segmentId),
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

      try {
        if (scope.authEnabled && scope.userId && isTtsRateLimitEnabled()) {
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
          );

          if (!rateLimitResult.allowed) {
            const resetTimeMs = rateLimitResult.resetTimeMs;
            const retryAfterSeconds = Math.max(0, Math.ceil((resetTimeMs - Date.now()) / 1000));
            const response = new NextResponse(JSON.stringify({
              type: 'https://openreader.app/problems/daily-quota-exceeded',
              title: 'Daily quota exceeded',
              status: 429,
              detail: 'Daily character limit exceeded',
              code: 'USER_DAILY_QUOTA_EXCEEDED',
              currentCount: rateLimitResult.currentCount,
              limit: rateLimitResult.limit,
              remainingChars: rateLimitResult.remainingChars,
              resetTimeMs,
              userType: scope.isAnonymousUser ? 'anonymous' : 'authenticated',
              upgradeHint: scope.isAnonymousUser
                ? `Sign up to increase your limit from ${formatLimitForHint(RATE_LIMITS.ANONYMOUS)} to ${formatLimitForHint(RATE_LIMITS.AUTHENTICATED)} characters per day`
                : undefined,
              instance: request.nextUrl.pathname,
            }), {
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

        const ttsBuffer = await generateTTSBuffer({
          text: segment.text,
          voice: parsed.settings.voice,
          speed: parsed.settings.nativeSpeed,
          format: 'mp3',
          model: parsed.settings.ttsModel,
          instructions: parsed.settings.ttsInstructions,
          provider: parsed.settings.ttsProvider,
          apiKey: request.headers.get('x-openai-key') || process.env.API_KEY || 'none',
          baseUrl: request.headers.get('x-openai-base-url') || process.env.API_BASE,
          testNamespace: scope.testNamespace,
        }, request.signal);

        await putTtsSegmentAudioObject(audioKey, ttsBuffer);

        let persistedBuffer = ttsBuffer;
        if (persistedBuffer.byteLength === 0) {
          persistedBuffer = await getTtsSegmentAudioObject(audioKey);
        }

        const durationMs = await probeAudioDurationMsFromBuffer(persistedBuffer, request.signal);
        let alignment: TTSSegmentManifestItem['alignment'] = null;
        try {
          const whisperBytes = Uint8Array.from(persistedBuffer);
          const aligned = await alignAudioWithText(
            whisperBytes.buffer,
            segment.text,
            undefined,
            { engine: 'whisper.cpp' },
          );
          alignment = aligned[0] ? { ...aligned[0], sentenceIndex: segment.original.segmentIndex } : null;
        } catch (alignError) {
          console.warn('Whisper alignment unavailable for segment; continuing without word highlights.', {
            segmentId: segment.segmentId,
            error: alignError instanceof Error ? alignError.message : String(alignError),
          });
          alignment = null;
        }

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

        manifest.push({
          segmentId: segment.segmentId,
          segmentIndex: segment.original.segmentIndex,
          segmentKey: segmentKeyForRow,
          ...buildSegmentAudioUrls(parsed.documentId, segment.segmentId),
          durationMs,
          alignment,
          locator: segment.locator,
          status: 'completed',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to generate segment';
        const aborted = isAbortLikeError(error);
        await db
          .update(ttsSegmentVariants)
          .set({
            status: aborted ? 'pending' : 'error',
            error: aborted ? null : message,
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
        });
      }
    }

    const response = NextResponse.json({
      documentId: parsed.documentId,
      segments: manifest,
    });
    attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
    return response;
  } catch (error) {
    console.error('Error ensuring TTS segments:', error);
    const response = NextResponse.json({ error: 'Failed to ensure TTS segments' }, { status: 500 });
    attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
    return response;
  }
}

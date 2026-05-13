import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { audiobooks, audiobookChapters } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { rateLimiter, RATE_LIMITS, isTtsRateLimitEnabled } from '@/lib/server/rate-limit/rate-limiter';
import { getClientIp } from '@/lib/server/rate-limit/request-ip';
import { getOrCreateDeviceId, setDeviceIdCookie } from '@/lib/server/rate-limit/device-id';
import {
  deleteAudiobookObject,
  getAudiobookObjectBuffer,
  isMissingBlobError,
  listAudiobookObjects,
  putAudiobookObject,
} from '@/lib/server/audiobooks/blobstore';
import {
  decodeChapterFileName,
  encodeChapterFileName,
  encodeChapterTitleTag,
  ffprobeAudio,
} from '@/lib/server/audiobooks/chapters';
import { isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/testing/test-namespace';
import { buildAllowedAudiobookUserIds, pickAudiobookOwner } from '@/lib/server/audiobooks/user-scope';
import { getFFmpegPath } from '@/lib/server/audiobooks/ffmpeg-bin';
import { generateTTSBuffer } from '@/lib/server/tts/generate';
import { getUpstreamRetryAfterSeconds, getUpstreamStatus } from '@/lib/server/tts/upstream-response';
import { supportsNativeModelSpeed } from '@/lib/shared/tts-provider-catalog';
import type { AudiobookGenerationSettings } from '@/types/client';
import type { TTSAudiobookFormat } from '@/types/tts';

export const dynamic = 'force-dynamic';

interface ConversionRequest {
  chapterTitle: string;
  text: string;
  bookId?: string;
  format?: TTSAudiobookFormat;
  chapterIndex?: number;
  settings?: unknown;
}

type ChapterObject = {
  index: number;
  title: string;
  format: TTSAudiobookFormat;
  fileName: string;
};

const SAFE_ID_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;
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

function isSafeId(value: string): boolean {
  return SAFE_ID_REGEX.test(value);
}

function s3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Audiobooks storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
}

function normalizeNativeSpeedForSettings(settings: AudiobookGenerationSettings): AudiobookGenerationSettings {
  return supportsNativeModelSpeed(settings.ttsProvider, settings.ttsModel)
    ? settings
    : { ...settings, nativeSpeed: 1 };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isAudiobookFormat(value: unknown): value is TTSAudiobookFormat {
  return value === 'mp3' || value === 'm4b';
}

function isAudiobookGenerationSettings(value: unknown): value is AudiobookGenerationSettings {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.ttsProvider === 'string'
    && typeof record.ttsModel === 'string'
    && typeof record.voice === 'string'
    && isFiniteNumber(record.nativeSpeed)
    && isFiniteNumber(record.postSpeed)
    && isAudiobookFormat(record.format)
    && (record.ttsInstructions === undefined || typeof record.ttsInstructions === 'string');
}

function chapterFileMimeType(format: TTSAudiobookFormat): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
}

function buildAtempoFilter(speed: number): string {
  const clamped = Math.max(0.5, Math.min(speed, 3));
  if (clamped <= 2) return `atempo=${clamped.toFixed(3)}`;
  const second = clamped / 2;
  return `atempo=2.0,atempo=${second.toFixed(3)}`;
}

function listChapterObjects(objectNames: string[]): ChapterObject[] {
  const chapters = objectNames
    .filter((name) => !name.startsWith('complete.'))
    .map((fileName) => {
      const decoded = decodeChapterFileName(fileName);
      if (!decoded) return null;
      return {
        index: decoded.index,
        title: decoded.title,
        format: decoded.format,
        fileName,
      } satisfies ChapterObject;
    })
    .filter((value): value is ChapterObject => Boolean(value))
    .sort((a, b) => a.index - b.index);

  const deduped = new Map<number, ChapterObject>();
  for (const chapter of chapters) {
    const existing = deduped.get(chapter.index);
    if (!existing || chapter.fileName > existing.fileName) {
      deduped.set(chapter.index, chapter);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => a.index - b.index);
}

function streamBuffer(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

async function runFFmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn(getFFmpegPath(), args);
    let finished = false;

    const onAbort = () => {
      if (finished) return;
      finished = true;
      try {
        ffmpeg.kill('SIGKILL');
      } catch {}
      reject(new Error('ABORTED'));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    ffmpeg.stderr.on('data', (data) => {
      console.error(`ffmpeg stderr: ${data}`);
    });

    ffmpeg.on('close', (code) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg process exited with code ${code}`));
      }
    });

    ffmpeg.on('error', (err) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

function chapterEncodeArgs(
  inputPath: string,
  outputPath: string,
  format: TTSAudiobookFormat,
  postSpeed: number,
  titleTag: string,
): string[] {
  if (format === 'mp3') {
    return [
      '-y',
      '-i',
      inputPath,
      ...(postSpeed !== 1 ? ['-filter:a', buildAtempoFilter(postSpeed)] : []),
      '-c:a',
      'libmp3lame',
      '-b:a',
      '64k',
      '-metadata',
      `title=${titleTag}`,
      outputPath,
    ];
  }

  return [
    '-y',
    '-i',
    inputPath,
    ...(postSpeed !== 1 ? ['-filter:a', buildAtempoFilter(postSpeed)] : []),
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-metadata',
    `title=${titleTag}`,
    '-f',
    'mp4',
    outputPath,
  ];
}

function findChapterFileNameByIndex(fileNames: string[], index: number): { fileName: string; title: string; format: 'mp3' | 'm4b' } | null {
  const matches = fileNames
    .map((fileName) => {
      const decoded = decodeChapterFileName(fileName);
      if (!decoded) return null;
      if (decoded.index !== index) return null;
      return { fileName, title: decoded.title, format: decoded.format };
    })
    .filter((value): value is { fileName: string; title: string; format: 'mp3' | 'm4b' } => Boolean(value))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));

  return matches.at(-1) ?? null;
}

export async function POST(request: NextRequest) {
  let workDir: string | null = null;
  let didCreateDeviceIdCookie = false;
  let deviceIdToSet: string | null = null;
  let providerForError: string | null = null;
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const data: ConversionRequest = await request.json();
    const requestedFormat = data.format || 'm4b';
    if (!data.text || typeof data.text !== 'string') {
      return NextResponse.json({ error: 'Missing text for TTS generation' }, { status: 400 });
    }

    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;

    const { userId, authEnabled, user } = ctxOrRes;
    const testNamespace = getOpenReaderTestNamespace(request.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
    const { preferredUserId, allowedUserIds } = buildAllowedAudiobookUserIds(authEnabled, userId, unclaimedUserId);
    const bookId = data.bookId || randomUUID();

    if (!isSafeId(bookId)) {
      return NextResponse.json({ error: 'Invalid bookId parameter' }, { status: 400 });
    }

    const existingBookRows = await db
      .select({ userId: audiobooks.userId })
      .from(audiobooks)
      .where(and(eq(audiobooks.id, bookId), inArray(audiobooks.userId, allowedUserIds)));
    const storageUserId =
      pickAudiobookOwner(
        existingBookRows.map((book: { userId: string }) => book.userId),
        preferredUserId,
        unclaimedUserId,
      ) ?? preferredUserId;

    await db
      .insert(audiobooks)
      .values({
        id: bookId,
        userId: storageUserId,
        title: data.chapterTitle || 'Untitled Audiobook',
      })
      .onConflictDoNothing();

    const objects = await listAudiobookObjects(bookId, storageUserId, testNamespace);
    const objectNames = objects.map((item) => item.fileName);
    const existingChapters = listChapterObjects(objectNames);
    const hasChapters = existingChapters.length > 0;

    let normalizedExistingSettings: AudiobookGenerationSettings | undefined;
    try {
      const parsedSettings = JSON.parse(
        (await getAudiobookObjectBuffer(bookId, storageUserId, 'audiobook.meta.json', testNamespace)).toString('utf8'),
      ) as unknown;
      if (!isAudiobookGenerationSettings(parsedSettings)) {
        console.error('Invalid audiobook.meta.json settings payload', { bookId, storageUserId });
        return NextResponse.json({ error: 'Invalid audiobook metadata settings' }, { status: 500 });
      }
      normalizedExistingSettings = normalizeNativeSpeedForSettings(parsedSettings);
    } catch (error) {
      if (!isMissingBlobError(error)) throw error;
      normalizedExistingSettings = undefined;
    }

    const incomingSettings = (() => {
      if (data.settings === undefined) {
        return undefined;
      }
      if (!isAudiobookGenerationSettings(data.settings)) {
        return null;
      }
      return normalizeNativeSpeedForSettings(data.settings);
    })();

    if (incomingSettings === null) {
      return NextResponse.json({ error: 'Invalid audiobook settings payload' }, { status: 400 });
    }

    const mergedSettings = normalizedExistingSettings && incomingSettings
      ? normalizeNativeSpeedForSettings({
          ...normalizedExistingSettings,
          ...incomingSettings,
        })
      : normalizedExistingSettings ?? incomingSettings;

    if (normalizedExistingSettings && hasChapters && incomingSettings) {
      const mismatch =
        normalizedExistingSettings.ttsProvider !== incomingSettings.ttsProvider ||
        normalizedExistingSettings.ttsModel !== incomingSettings.ttsModel ||
        normalizedExistingSettings.voice !== incomingSettings.voice ||
        normalizedExistingSettings.nativeSpeed !== incomingSettings.nativeSpeed ||
        normalizedExistingSettings.postSpeed !== incomingSettings.postSpeed ||
        normalizedExistingSettings.format !== incomingSettings.format ||
        (normalizedExistingSettings.ttsInstructions || '') !== (incomingSettings.ttsInstructions || '');
      if (mismatch) {
        return NextResponse.json({ error: 'Audiobook settings mismatch', settings: normalizedExistingSettings }, { status: 409 });
      }
    }

    const existingFormats = new Set(existingChapters.map((chapter) => chapter.format));
    if (existingFormats.size > 1) {
      return NextResponse.json({ error: 'Mixed chapter formats detected; reset the audiobook to continue' }, { status: 400 });
    }

    const format: TTSAudiobookFormat =
      (existingFormats.values().next().value as TTSAudiobookFormat | undefined) ??
      mergedSettings?.format ??
      requestedFormat;
    const rawPostSpeed = mergedSettings?.postSpeed ?? 1;
    const postSpeed = Number.isFinite(Number(rawPostSpeed)) ? Number(rawPostSpeed) : 1;

    let chapterIndex: number;
    if (data.chapterIndex !== undefined) {
      const normalized = Number(data.chapterIndex);
      if (!Number.isInteger(normalized) || normalized < 0) {
        return NextResponse.json({ error: 'Invalid chapterIndex parameter' }, { status: 400 });
      }
      chapterIndex = normalized;
    } else {
      const indices = existingChapters.map((c) => c.index);
      let next = 0;
      for (const idx of indices) {
        if (idx === next) {
          next++;
        } else if (idx > next) {
          break;
        }
      }
      chapterIndex = next;
    }

    const provider = request.headers.get('x-tts-provider')
      || mergedSettings?.ttsProvider
      || 'openai';
    providerForError = provider;
    const openApiKey = request.headers.get('x-openai-key') || process.env.API_KEY || 'none';
    const openApiBaseUrl = request.headers.get('x-openai-base-url') || process.env.API_BASE;
    const model = mergedSettings?.ttsModel;
    const voice = mergedSettings?.voice
      || (provider === 'openai'
        ? 'alloy'
        : provider === 'deepinfra'
          ? 'af_bella'
          : 'af_sarah');
    const rawNativeSpeed = mergedSettings?.nativeSpeed ?? 1;
    const nativeSpeed = Number.isFinite(Number(rawNativeSpeed)) ? Number(rawNativeSpeed) : 1;
    const instructions = mergedSettings?.ttsInstructions;

    if (authEnabled && userId && isTtsRateLimitEnabled()) {
      const isAnonymous = Boolean(user?.isAnonymous);
      const charCount = data.text.length;
      const ip = getClientIp(request);
      const device = isAnonymous ? getOrCreateDeviceId(request) : null;
      if (device?.didCreate) {
        didCreateDeviceIdCookie = true;
        deviceIdToSet = device.deviceId;
      }

      const rateLimitResult = await rateLimiter.checkAndIncrementLimit(
        { id: userId, isAnonymous },
        charCount,
        {
          deviceId: device?.deviceId ?? null,
          ip,
        },
      );

      if (!rateLimitResult.allowed) {
        const resetTimeMs = rateLimitResult.resetTimeMs;
        const retryAfterSeconds = Math.max(
          0,
          Math.ceil((resetTimeMs - Date.now()) / 1000),
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
          instance: request.nextUrl.pathname,
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

    const ttsBuffer = await generateTTSBuffer(
      {
        text: data.text,
        voice,
        speed: nativeSpeed,
        format: 'mp3',
        model,
        instructions,
        provider,
        apiKey: openApiKey,
        baseUrl: openApiBaseUrl,
        testNamespace,
      },
      request.signal,
    );

    workDir = await mkdtemp(join(tmpdir(), 'openreader-audiobook-'));
    const inputPath = join(workDir, `${chapterIndex}-input.mp3`);
    const chapterOutputTempPath = join(workDir, `${chapterIndex}-chapter.tmp.${format}`);
    const titleTag = encodeChapterTitleTag(chapterIndex, data.chapterTitle);

    await writeFile(inputPath, ttsBuffer);

    const canCopyMp3WithoutReencode = format === 'mp3' && postSpeed === 1;
    if (canCopyMp3WithoutReencode) {
      try {
        await runFFmpeg(
          [
            '-y',
            '-i',
            inputPath,
            '-c:a',
            'copy',
            '-map_metadata',
            '-1',
            '-id3v2_version',
            '3',
            '-metadata',
            `title=${titleTag}`,
            chapterOutputTempPath,
          ],
          request.signal,
        );
      } catch (copyError) {
        console.warn('Chapter remux failed; falling back to mp3 re-encode:', copyError);
        await runFFmpeg(
          chapterEncodeArgs(inputPath, chapterOutputTempPath, format, postSpeed, titleTag),
          request.signal,
        );
      }
    } else {
      await runFFmpeg(
        chapterEncodeArgs(inputPath, chapterOutputTempPath, format, postSpeed, titleTag),
        request.signal,
      );
    }

    const probe = await ffprobeAudio(chapterOutputTempPath, request.signal);
    const duration = probe.durationSec ?? 0;

    const finalChapterName = encodeChapterFileName(chapterIndex, data.chapterTitle, format);
    const finalChapterBytes = await readFile(chapterOutputTempPath);
    await putAudiobookObject(bookId, storageUserId, finalChapterName, finalChapterBytes, chapterFileMimeType(format), testNamespace);

    const chapterPrefix = `${String(chapterIndex + 1).padStart(4, '0')}__`;
    for (const fileName of objectNames) {
      if (!fileName.startsWith(chapterPrefix)) continue;
      if (!fileName.endsWith('.mp3') && !fileName.endsWith('.m4b')) continue;
      if (fileName === finalChapterName) continue;
      await deleteAudiobookObject(bookId, storageUserId, fileName, testNamespace).catch(() => {});
    }

    await deleteAudiobookObject(bookId, storageUserId, 'complete.mp3', testNamespace).catch(() => {});
    await deleteAudiobookObject(bookId, storageUserId, 'complete.m4b', testNamespace).catch(() => {});
    await deleteAudiobookObject(bookId, storageUserId, 'complete.mp3.manifest.json', testNamespace).catch(() => {});
    await deleteAudiobookObject(bookId, storageUserId, 'complete.m4b.manifest.json', testNamespace).catch(() => {});

    if (!normalizedExistingSettings && incomingSettings) {
      await putAudiobookObject(
        bookId,
        storageUserId,
        'audiobook.meta.json',
        Buffer.from(JSON.stringify(incomingSettings, null, 2), 'utf8'),
        'application/json; charset=utf-8',
        testNamespace,
      );
    }

    await db
      .insert(audiobookChapters)
      .values({
        id: `${bookId}-${chapterIndex}`,
        bookId,
        userId: storageUserId,
        chapterIndex,
        title: data.chapterTitle,
        duration,
        format,
        filePath: finalChapterName,
      })
      .onConflictDoUpdate({
        target: [audiobookChapters.id, audiobookChapters.userId],
        set: { title: data.chapterTitle, duration, format, filePath: finalChapterName },
      });

    const response = NextResponse.json({
      index: chapterIndex,
      title: data.chapterTitle,
      duration,
      status: 'completed' as const,
      bookId,
      format,
    });
    attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
    return response;
  } catch (error) {
    if ((error as Error)?.message === 'ABORTED' || (error as Error)?.name === 'AbortError' || request.signal.aborted) {
      const response = NextResponse.json({ error: 'cancelled' }, { status: 499 });
      attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
      return response;
    }

    const upstreamStatus = getUpstreamStatus(error);
    if (upstreamStatus === 429) {
      const retryAfterSeconds = getUpstreamRetryAfterSeconds(error);
      const problem: ProblemDetails = {
        type: PROBLEM_TYPES.upstreamRateLimited,
        title: 'Upstream rate limited',
        status: 429,
        detail: retryAfterSeconds
          ? `The TTS provider is rate limiting requests. Please retry in about ${retryAfterSeconds}s.`
          : 'The TTS provider is rate limiting requests. Please try again shortly.',
        code: 'UPSTREAM_RATE_LIMIT',
        provider: providerForError ?? undefined,
        upstreamStatus,
        retryAfterSeconds,
        instance: request.nextUrl.pathname,
      };

      const response = new NextResponse(JSON.stringify(problem), {
        status: 429,
        headers: {
          'Content-Type': 'application/problem+json',
          ...(retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {}),
        },
      });

      attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
      return response;
    }

    console.error('Error processing audio chapter:', error);
    const response = NextResponse.json({ error: 'Failed to process audio chapter' }, { status: 500 });
    attachDeviceIdCookie(response, deviceIdToSet, didCreateDeviceIdCookie);
    return response;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function GET(request: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const bookId = request.nextUrl.searchParams.get('bookId');
    const chapterIndexStr = request.nextUrl.searchParams.get('chapterIndex');

    if (!bookId || !chapterIndexStr) {
      return NextResponse.json({ error: 'Missing bookId or chapterIndex parameter' }, { status: 400 });
    }

    const chapterIndex = Number.parseInt(chapterIndexStr, 10);
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0) {
      return NextResponse.json({ error: 'Invalid chapterIndex parameter' }, { status: 400 });
    }

    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;

    const { userId, authEnabled } = ctxOrRes;
    const testNamespace = getOpenReaderTestNamespace(request.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
    const { preferredUserId, allowedUserIds } = buildAllowedAudiobookUserIds(authEnabled, userId, unclaimedUserId);
    const existingBookRows = await db
      .select({ userId: audiobooks.userId })
      .from(audiobooks)
      .where(and(eq(audiobooks.id, bookId), inArray(audiobooks.userId, allowedUserIds)));
    const existingBookUserId = pickAudiobookOwner(
      existingBookRows.map((book: { userId: string }) => book.userId),
      preferredUserId,
      unclaimedUserId,
    );

    if (!existingBookUserId) {
      return NextResponse.json({ error: 'Book not found' }, { status: 404 });
    }

    const objects = await listAudiobookObjects(bookId, existingBookUserId, testNamespace);
    const chapter = findChapterFileNameByIndex(
      objects.map((object) => object.fileName),
      chapterIndex,
    );

    if (!chapter) {
      await db
        .delete(audiobookChapters)
        .where(
          and(
            eq(audiobookChapters.bookId, bookId),
            eq(audiobookChapters.userId, existingBookUserId),
            eq(audiobookChapters.chapterIndex, chapterIndex),
          ),
        );
      return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });
    }

    let buffer: Buffer;
    try {
      buffer = await getAudiobookObjectBuffer(bookId, existingBookUserId, chapter.fileName, testNamespace);
    } catch (error) {
      if (isMissingBlobError(error)) {
        await db
          .delete(audiobookChapters)
          .where(
            and(
              eq(audiobookChapters.bookId, bookId),
              eq(audiobookChapters.userId, existingBookUserId),
              eq(audiobookChapters.chapterIndex, chapterIndex),
            ),
          );
        return NextResponse.json({ error: 'Chapter not found' }, { status: 404 });
      }
      throw error;
    }

    const mimeType = chapter.format === 'mp3' ? 'audio/mpeg' : 'audio/mp4';
    const sanitizedTitle = chapter.title.replace(/[^a-z0-9]/gi, '_').toLowerCase();

    return new NextResponse(streamBuffer(buffer), {
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${sanitizedTitle}.${chapter.format}"`,
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    console.error('Error downloading chapter:', error);
    return NextResponse.json({ error: 'Failed to download chapter' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const bookId = request.nextUrl.searchParams.get('bookId');
    const chapterIndexStr = request.nextUrl.searchParams.get('chapterIndex');

    if (!bookId || !chapterIndexStr) {
      return NextResponse.json({ error: 'Missing bookId or chapterIndex parameter' }, { status: 400 });
    }

    const chapterIndex = Number.parseInt(chapterIndexStr, 10);
    if (!Number.isInteger(chapterIndex) || chapterIndex < 0) {
      return NextResponse.json({ error: 'Invalid chapterIndex parameter' }, { status: 400 });
    }

    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;

    const { userId, authEnabled } = ctxOrRes;
    const testNamespace = getOpenReaderTestNamespace(request.headers);
    const unclaimedUserId = getUnclaimedUserIdForNamespace(testNamespace);
    const { preferredUserId, allowedUserIds } = buildAllowedAudiobookUserIds(authEnabled, userId, unclaimedUserId);
    const existingBookRows = await db
      .select({ userId: audiobooks.userId })
      .from(audiobooks)
      .where(and(eq(audiobooks.id, bookId), inArray(audiobooks.userId, allowedUserIds)));
    const storageUserId = pickAudiobookOwner(
      existingBookRows.map((book: { userId: string }) => book.userId),
      preferredUserId,
      unclaimedUserId,
    );

    if (!storageUserId) {
      return NextResponse.json({ error: 'Book not found' }, { status: 404 });
    }

    await db
      .delete(audiobookChapters)
      .where(
        and(
          eq(audiobookChapters.bookId, bookId),
          eq(audiobookChapters.userId, storageUserId),
          eq(audiobookChapters.chapterIndex, chapterIndex),
        ),
      );

    const objectNames = (await listAudiobookObjects(bookId, storageUserId, testNamespace)).map((object) => object.fileName);
    const chapterPrefix = `${String(chapterIndex + 1).padStart(4, '0')}__`;

    for (const fileName of objectNames) {
      if (!fileName.startsWith(chapterPrefix)) continue;
      if (!fileName.endsWith('.mp3') && !fileName.endsWith('.m4b')) continue;
      await deleteAudiobookObject(bookId, storageUserId, fileName, testNamespace).catch(() => {});
    }

    await deleteAudiobookObject(bookId, storageUserId, 'complete.mp3', testNamespace).catch(() => {});
    await deleteAudiobookObject(bookId, storageUserId, 'complete.m4b', testNamespace).catch(() => {});
    await deleteAudiobookObject(bookId, storageUserId, 'complete.mp3.manifest.json', testNamespace).catch(() => {});
    await deleteAudiobookObject(bookId, storageUserId, 'complete.m4b.manifest.json', testNamespace).catch(() => {});

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting chapter:', error);
    return NextResponse.json({ error: 'Failed to delete chapter' }, { status: 500 });
  }
}

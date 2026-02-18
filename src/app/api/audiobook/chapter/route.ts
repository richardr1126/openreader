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
import type { AudiobookGenerationSettings } from '@/types/client';
import type { TTSAudioBytes, TTSAudiobookFormat } from '@/types/tts';

export const dynamic = 'force-dynamic';

interface ConversionRequest {
  chapterTitle: string;
  buffer: TTSAudioBytes;
  bookId?: string;
  format?: TTSAudiobookFormat;
  chapterIndex?: number;
  settings?: AudiobookGenerationSettings;
}

type ChapterObject = {
  index: number;
  title: string;
  format: TTSAudiobookFormat;
  fileName: string;
};

const SAFE_ID_REGEX = /^[a-zA-Z0-9._-]{1,128}$/;

function isSafeId(value: string): boolean {
  return SAFE_ID_REGEX.test(value);
}

function s3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Audiobooks storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
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
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const data: ConversionRequest = await request.json();
    const requestedFormat = data.format || 'm4b';

    const ctxOrRes = await requireAuthContext(request);
    if (ctxOrRes instanceof Response) return ctxOrRes;

    const { userId, authEnabled } = ctxOrRes;
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

    let existingSettings: AudiobookGenerationSettings | null = null;
    try {
      existingSettings = JSON.parse(
        (await getAudiobookObjectBuffer(bookId, storageUserId, 'audiobook.meta.json', testNamespace)).toString('utf8'),
      ) as AudiobookGenerationSettings;
    } catch (error) {
      if (!isMissingBlobError(error)) throw error;
      existingSettings = null;
    }

    const incomingSettings = data.settings;
    if (existingSettings && hasChapters && incomingSettings) {
      const mismatch =
        existingSettings.ttsProvider !== incomingSettings.ttsProvider ||
        existingSettings.ttsModel !== incomingSettings.ttsModel ||
        existingSettings.voice !== incomingSettings.voice ||
        existingSettings.nativeSpeed !== incomingSettings.nativeSpeed ||
        existingSettings.postSpeed !== incomingSettings.postSpeed ||
        existingSettings.format !== incomingSettings.format;
      if (mismatch) {
        return NextResponse.json({ error: 'Audiobook settings mismatch', settings: existingSettings }, { status: 409 });
      }
    }

    const existingFormats = new Set(existingChapters.map((chapter) => chapter.format));
    if (existingFormats.size > 1) {
      return NextResponse.json({ error: 'Mixed chapter formats detected; reset the audiobook to continue' }, { status: 400 });
    }

    const format: TTSAudiobookFormat =
      (existingFormats.values().next().value as TTSAudiobookFormat | undefined) ??
      existingSettings?.format ??
      incomingSettings?.format ??
      requestedFormat;
    const rawPostSpeed = incomingSettings?.postSpeed ?? existingSettings?.postSpeed ?? 1;
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

    workDir = await mkdtemp(join(tmpdir(), 'openreader-audiobook-'));
    const inputPath = join(workDir, `${chapterIndex}-input.mp3`);
    const chapterOutputTempPath = join(workDir, `${chapterIndex}-chapter.tmp.${format}`);
    const titleTag = encodeChapterTitleTag(chapterIndex, data.chapterTitle);

    await writeFile(inputPath, Buffer.from(new Uint8Array(data.buffer)));

    if (format === 'mp3') {
      await runFFmpeg(
        [
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
          chapterOutputTempPath,
        ],
        request.signal,
      );
    } else {
      await runFFmpeg(
        [
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
          chapterOutputTempPath,
        ],
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

    if (!existingSettings && incomingSettings) {
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

    return NextResponse.json({
      index: chapterIndex,
      title: data.chapterTitle,
      duration,
      status: 'completed' as const,
      bookId,
      format,
    });
  } catch (error) {
    if ((error as Error)?.message === 'ABORTED' || request.signal.aborted) {
      return NextResponse.json({ error: 'cancelled' }, { status: 499 });
    }
    console.error('Error processing audio chapter:', error);
    return NextResponse.json({ error: 'Failed to process audio chapter' }, { status: 500 });
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

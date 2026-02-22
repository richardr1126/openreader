import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { audiobooks, audiobookChapters } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import {
  audiobookPrefix,
  deleteAudiobookObject,
  deleteAudiobookPrefix,
  getAudiobookObjectBuffer,
  listAudiobookObjects,
  putAudiobookObject,
} from '@/lib/server/audiobooks/blobstore';
import {
  decodeChapterFileName,
  escapeFFMetadata,
  ffprobeAudio,
} from '@/lib/server/audiobooks/chapters';
import { isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/testing/test-namespace';
import { getFFmpegPath } from '@/lib/server/audiobooks/ffmpeg-bin';
import { buildAllowedAudiobookUserIds, pickAudiobookOwner } from '@/lib/server/audiobooks/user-scope';
import type { TTSAudiobookFormat } from '@/types/tts';

export const dynamic = 'force-dynamic';

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
    if (!existing) {
      deduped.set(chapter.index, chapter);
      continue;
    }
    if (chapter.fileName > existing.fileName) {
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

async function ensurePositiveDuration(filePath: string, signal?: AbortSignal): Promise<void> {
  const probe = await ffprobeAudio(filePath, signal);
  if (!probe.durationSec || probe.durationSec <= 0) {
    throw new Error(`Invalid duration for output file: ${filePath}`);
  }
}

export async function GET(request: NextRequest) {
  let workDir: string | null = null;
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const bookId = request.nextUrl.searchParams.get('bookId');
    const requestedFormat = request.nextUrl.searchParams.get('format') as TTSAudiobookFormat | null;
    if (!bookId) {
      return NextResponse.json({ error: 'Missing bookId parameter' }, { status: 400 });
    }
    if (!isSafeId(bookId)) {
      return NextResponse.json({ error: 'Invalid bookId parameter' }, { status: 400 });
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
    const objectNames = objects.map((item) => item.fileName);
    const chapters = listChapterObjects(objectNames);
    if (chapters.length === 0) {
      return NextResponse.json({ error: 'No chapters found' }, { status: 404 });
    }

    const chapterFormats = new Set(chapters.map((chapter) => chapter.format));
    if (chapterFormats.size > 1) {
      return NextResponse.json({ error: 'Mixed chapter formats detected; reset the audiobook to continue' }, { status: 400 });
    }

    const format: TTSAudiobookFormat = requestedFormat ?? chapters[0].format;
    const completeName = `complete.${format}`;
    const manifestName = `${completeName}.manifest.json`;
    const signature = chapters.map((chapter) => ({ index: chapter.index, fileName: chapter.fileName }));

    if (objectNames.includes(completeName) && objectNames.includes(manifestName)) {
      try {
        const manifest = JSON.parse((await getAudiobookObjectBuffer(bookId, existingBookUserId, manifestName, testNamespace)).toString('utf8'));
        if (JSON.stringify(manifest) === JSON.stringify(signature)) {
          const cached = await getAudiobookObjectBuffer(bookId, existingBookUserId, completeName, testNamespace);
          return new NextResponse(streamBuffer(cached), {
            headers: {
              'Content-Type': chapterFileMimeType(format),
              'Content-Disposition': `attachment; filename="audiobook.${format}"`,
              'Cache-Control': 'no-cache',
            },
          });
        }
      } catch {
        // Force regeneration below.
      }

      await deleteAudiobookObject(bookId, existingBookUserId, completeName, testNamespace).catch(() => {});
      await deleteAudiobookObject(bookId, existingBookUserId, manifestName, testNamespace).catch(() => {});
    }

    const chapterRows = await db
      .select({ chapterIndex: audiobookChapters.chapterIndex, duration: audiobookChapters.duration })
      .from(audiobookChapters)
      .where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, existingBookUserId)));
    const durationByIndex = new Map<number, number>();
    for (const row of chapterRows) {
      durationByIndex.set(row.chapterIndex, Number(row.duration ?? 0));
    }

    workDir = await mkdtemp(join(tmpdir(), 'openreader-audiobook-combine-'));
    const metadataPath = join(workDir, 'metadata.txt');
    const listPath = join(workDir, 'list.txt');
    const outputPath = join(workDir, completeName);

    const localChapters: Array<{ index: number; title: string; localPath: string; duration: number }> = [];
    for (const chapter of chapters) {
      const localPath = join(workDir, chapter.fileName);
      const bytes = await getAudiobookObjectBuffer(bookId, existingBookUserId, chapter.fileName, testNamespace);
      await writeFile(localPath, bytes);

      let duration = 0;
      try {
        const probe = await ffprobeAudio(localPath, request.signal);
        if (probe.durationSec && probe.durationSec > 0) {
          duration = probe.durationSec;
        }
      } catch {
        duration = 0;
      }
      if (!duration || duration <= 0) {
        duration = durationByIndex.get(chapter.index) ?? 0;
      }

      localChapters.push({
        index: chapter.index,
        title: chapter.title,
        localPath,
        duration,
      });
    }

    const metadata: string[] = [];
    let currentTime = 0;
    for (const chapter of localChapters) {
      const startMs = Math.floor(currentTime * 1000);
      currentTime += chapter.duration;
      const endMs = Math.floor(currentTime * 1000);
      metadata.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${startMs}`, `END=${endMs}`, `title=${escapeFFMetadata(chapter.title)}`);
    }

    await writeFile(metadataPath, ';FFMETADATA1\n' + metadata.join('\n'));
    await writeFile(
      listPath,
      localChapters
        .map((chapter) => `file '${chapter.localPath.replace(/'/g, "'\\''")}'`)
        .join('\n'),
    );

    if (format === 'mp3') {
      try {
        await runFFmpeg(
          ['-f', 'concat', '-safe', '0', '-i', listPath, '-map_metadata', '-1', '-c:a', 'copy', outputPath],
          request.signal,
        );
      } catch (copyError) {
        console.warn('MP3 concat copy failed; falling back to re-encode:', copyError);
        await runFFmpeg(
          ['-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'libmp3lame', '-b:a', '64k', outputPath],
          request.signal,
        );
      }
    } else {
      try {
        await runFFmpeg(
          [
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            listPath,
            '-i',
            metadataPath,
            '-map_metadata',
            '1',
            '-c:a',
            'copy',
            '-f',
            'mp4',
            outputPath,
          ],
          request.signal,
        );
      } catch (copyError) {
        console.warn('M4B concat copy failed; falling back to re-encode:', copyError);
        await runFFmpeg(
          [
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            listPath,
            '-i',
            metadataPath,
            '-map_metadata',
            '1',
            '-c:a',
            'aac',
            '-b:a',
            '64k',
            '-f',
            'mp4',
            outputPath,
          ],
          request.signal,
        );
      }
    }
    await ensurePositiveDuration(outputPath, request.signal);

    const outputBytes = await readFile(outputPath);
    await putAudiobookObject(bookId, existingBookUserId, completeName, outputBytes, chapterFileMimeType(format), testNamespace);
    await putAudiobookObject(
      bookId,
      existingBookUserId,
      manifestName,
      Buffer.from(JSON.stringify(signature, null, 2), 'utf8'),
      'application/json; charset=utf-8',
      testNamespace,
    );

    return new NextResponse(streamBuffer(outputBytes), {
      headers: {
        'Content-Type': chapterFileMimeType(format),
        'Content-Disposition': `attachment; filename="audiobook.${format}"`,
        'Cache-Control': 'no-cache',
      },
    });
  } catch (error) {
    if ((error as Error)?.message === 'ABORTED' || request.signal.aborted) {
      return NextResponse.json({ error: 'cancelled' }, { status: 499 });
    }
    console.error('Error creating full audiobook:', error);
    return NextResponse.json({ error: 'Failed to create full audiobook file' }, { status: 500 });
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const bookId = request.nextUrl.searchParams.get('bookId');
    if (!bookId) {
      return NextResponse.json({ error: 'Missing bookId parameter' }, { status: 400 });
    }
    if (!isSafeId(bookId)) {
      return NextResponse.json({ error: 'Invalid bookId parameter' }, { status: 400 });
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
      .where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, storageUserId)));

    await db.delete(audiobooks).where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, storageUserId)));

    const deleted = await deleteAudiobookPrefix(audiobookPrefix(bookId, storageUserId, testNamespace)).catch(() => 0);
    return NextResponse.json({ success: true, existed: deleted > 0 });
  } catch (error) {
    console.error('Error resetting audiobook:', error);
    return NextResponse.json({ error: 'Failed to reset audiobook' }, { status: 500 });
  }
}

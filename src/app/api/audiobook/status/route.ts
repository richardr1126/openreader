import { NextRequest, NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db';
import { audiobooks, audiobookChapters } from '@/db/schema';
import { requireAuthContext } from '@/lib/server/auth/auth';
import { getAudiobookObjectBuffer, isMissingBlobError, listAudiobookObjects } from '@/lib/server/audiobooks/blobstore';
import { decodeChapterFileName } from '@/lib/server/audiobooks/chapters';
import { pruneAudiobookChaptersNotOnDisk } from '@/lib/server/audiobooks/prune';
import { isS3Configured } from '@/lib/server/storage/s3';
import { getOpenReaderTestNamespace, getUnclaimedUserIdForNamespace } from '@/lib/server/testing/test-namespace';
import { buildAllowedAudiobookUserIds, pickAudiobookOwner } from '@/lib/server/audiobooks/user-scope';
import type { AudiobookGenerationSettings } from '@/types/client';
import type { TTSAudiobookChapter, TTSAudiobookFormat } from '@/types/tts';

export const dynamic = 'force-dynamic';

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

type ChapterObject = {
  index: number;
  title: string;
  format: TTSAudiobookFormat;
  fileName: string;
};

function listChapterObjects(fileNames: string[]): ChapterObject[] {
  const chapters = fileNames
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
    const current = deduped.get(chapter.index);
    if (!current || chapter.fileName > current.fileName) {
      deduped.set(chapter.index, chapter);
    }
  }

  return Array.from(deduped.values()).sort((a, b) => a.index - b.index);
}

export async function GET(request: NextRequest) {
  try {
    if (!isS3Configured()) return s3NotConfiguredResponse();

    const bookId = request.nextUrl.searchParams.get('bookId');
    if (!bookId || !isSafeId(bookId)) {
      return NextResponse.json({ error: 'Missing bookId parameter' }, { status: 400 });
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
      return NextResponse.json({
        chapters: [],
        exists: false,
        hasComplete: false,
        bookId: null,
        settings: null,
      });
    }

    const objects = await listAudiobookObjects(bookId, existingBookUserId, testNamespace);
    const objectNames = objects.map((object) => object.fileName);
    const chapterObjects = listChapterObjects(objectNames);

    await pruneAudiobookChaptersNotOnDisk(
      bookId,
      existingBookUserId,
      chapterObjects.map((chapter) => chapter.index),
    );

    const chapterRows = await db
      .select({ chapterIndex: audiobookChapters.chapterIndex, duration: audiobookChapters.duration })
      .from(audiobookChapters)
      .where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, existingBookUserId)));
    const durationByIndex = new Map<number, number>();
    for (const row of chapterRows) {
      durationByIndex.set(row.chapterIndex, Number(row.duration ?? 0));
    }

    const chapters: TTSAudiobookChapter[] = chapterObjects.map((chapter) => ({
      index: chapter.index,
      title: chapter.title,
      duration: durationByIndex.get(chapter.index),
      status: 'completed',
      bookId,
      format: chapter.format,
    }));

    let settings: AudiobookGenerationSettings | null = null;
    try {
      settings = JSON.parse((await getAudiobookObjectBuffer(bookId, existingBookUserId, 'audiobook.meta.json', testNamespace)).toString('utf8')) as AudiobookGenerationSettings;
    } catch (error) {
      if (!isMissingBlobError(error)) throw error;
      settings = null;
    }

    const hasComplete = objectNames.includes('complete.mp3') || objectNames.includes('complete.m4b');
    const exists = chapters.length > 0 || hasComplete || settings !== null;

    if (!exists) {
      // Deleting the audiobook row cascades to audiobookChapters via bookFk
      await db.delete(audiobooks).where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, existingBookUserId)));
      return NextResponse.json({
        chapters: [],
        exists: false,
        hasComplete: false,
        bookId: null,
        settings: null,
      });
    }

    return NextResponse.json({
      chapters,
      exists: true,
      hasComplete,
      bookId,
      settings,
    });
  } catch (error) {
    console.error('Error fetching chapters:', error);
    return NextResponse.json({ error: 'Failed to fetch chapters' }, { status: 500 });
  }
}

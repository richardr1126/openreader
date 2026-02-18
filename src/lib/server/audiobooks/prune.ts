import { and, eq, notInArray } from 'drizzle-orm';

import { db } from '@/db';
import { audiobooks, audiobookChapters } from '@/db/schema';

export async function pruneAudiobookIfMissingDir(bookId: string, userId: string, intermediateDirExists: boolean): Promise<void> {
  if (intermediateDirExists) return;
  await db.delete(audiobookChapters).where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, userId)));
  await db.delete(audiobooks).where(and(eq(audiobooks.id, bookId), eq(audiobooks.userId, userId)));
}

export async function pruneAudiobookChaptersNotOnDisk(
  bookId: string,
  userId: string,
  presentChapterIndexes: number[],
): Promise<void> {
  if (presentChapterIndexes.length === 0) {
    await db
      .delete(audiobookChapters)
      .where(and(eq(audiobookChapters.bookId, bookId), eq(audiobookChapters.userId, userId)));
    return;
  }
  await db
    .delete(audiobookChapters)
    .where(
      and(
        eq(audiobookChapters.bookId, bookId),
        eq(audiobookChapters.userId, userId),
        notInArray(audiobookChapters.chapterIndex, presentChapterIndexes),
      ),
    );
}

export async function pruneAudiobookChapterIfMissingFile(bookId: string, userId: string, chapterIndex: number, chapterFileExists: boolean): Promise<void> {
  if (chapterFileExists) return;
  await db
    .delete(audiobookChapters)
    .where(
      and(
        eq(audiobookChapters.bookId, bookId),
        eq(audiobookChapters.userId, userId),
        eq(audiobookChapters.chapterIndex, chapterIndex),
      ),
    );
}

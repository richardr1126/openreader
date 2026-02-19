import { db } from '@/db';
import { documents, audiobooks, audiobookChapters, userPreferences, userDocumentProgress } from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { UNCLAIMED_USER_ID } from '../storage/docstore-legacy';
import {
  deleteAudiobookObject,
  getAudiobookObjectBuffer,
  listAudiobookObjects,
  putAudiobookObject,
} from '../audiobooks/blobstore';
import { isS3Configured } from '../storage/s3';

import { isAuthEnabled } from '@/lib/server/auth/config';

type AudiobookRow = {
  id: string;
  userId: string;
  title: string;
  author: string | null;
  description: string | null;
  coverPath: string | null;
  duration: number | null;
  createdAt: number;
};

type AudiobookChapterRow = {
  id: string;
  bookId: string;
  userId: string;
  chapterIndex: number;
  title: string;
  duration: number | null;
  filePath: string;
  format: string;
};

type UserPreferenceRow = {
  userId: string;
  dataJson: unknown;
  clientUpdatedAtMs: number;
  createdAt: number;
  updatedAt: number;
};

type UserDocumentProgressRow = {
  userId: string;
  documentId: string;
  readerType: string;
  location: string;
  progress: number | null;
  clientUpdatedAtMs: number;
  createdAt: number;
  updatedAt: number;
};

function contentTypeForAudiobookObject(fileName: string): string {
  if (fileName.endsWith('.mp3')) return 'audio/mpeg';
  if (fileName.endsWith('.m4b')) return 'audio/mp4';
  if (fileName.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

async function moveAudiobookBlobScope(
  bookId: string,
  fromUserId: string,
  toUserId: string,
  namespace: string | null,
): Promise<void> {
  if (fromUserId === toUserId) return;

  const objects = await listAudiobookObjects(bookId, fromUserId, namespace);
  if (objects.length === 0) return;

  for (const object of objects) {
    const bytes = await getAudiobookObjectBuffer(bookId, fromUserId, object.fileName, namespace);
    await putAudiobookObject(
      bookId,
      toUserId,
      object.fileName,
      bytes,
      contentTypeForAudiobookObject(object.fileName),
      namespace,
    );
  }

  for (const object of objects) {
    await deleteAudiobookObject(bookId, fromUserId, object.fileName, namespace).catch(() => {});
  }
}

export async function claimAnonymousData(userId: string, unclaimedUserId: string = UNCLAIMED_USER_ID, namespace: string | null = null) {
  if (!isAuthEnabled() || !userId) {
    return { documents: 0, audiobooks: 0, preferences: 0, progress: 0 };
  }

  const [documentsClaimed, audiobooksClaimed, preferencesClaimed, progressClaimed] = await Promise.all([
    transferUserDocuments(unclaimedUserId, userId),
    transferUserAudiobooks(unclaimedUserId, userId, namespace),
    transferUserPreferences(unclaimedUserId, userId),
    transferUserProgress(unclaimedUserId, userId),
  ]);

  return {
    documents: documentsClaimed,
    audiobooks: audiobooksClaimed,
    preferences: preferencesClaimed,
    progress: progressClaimed,
  };
}

/**
 * Transfer documents from one userId to another.
 *
 * This is used when an anonymous user upgrades to an authenticated account.
 * The underlying blob storage is shared (by sha), so this only moves metadata rows.
 *
 * @returns number of document rows transferred
 */
export async function transferUserDocuments(
  fromUserId: string,
  toUserId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: { db?: any },
): Promise<number> {
  if (!isAuthEnabled() || !fromUserId || !toUserId) return 0;
  if (fromUserId === toUserId) return 0;

  const database = options?.db ?? db;

  const rows = await database.select().from(documents).where(eq(documents.userId, fromUserId));
  if (rows.length === 0) return 0;

  await database
    .insert(documents)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .values(rows.map((row: any) => ({ ...row, userId: toUserId })))
    .onConflictDoNothing();

  await database.delete(documents).where(eq(documents.userId, fromUserId));
  return rows.length;
}

/**
 * Transfer audiobooks from one user to another.
 * Used when an anonymous user creates a real account.
 * @returns number of audiobooks transferred
 */
export async function transferUserAudiobooks(
  fromUserId: string,
  toUserId: string,
  namespace: string | null = null,
): Promise<number> {
  if (!isAuthEnabled() || !fromUserId || !toUserId) return 0;
  if (fromUserId === toUserId) return 0;

  const books = (await db
    .select()
    .from(audiobooks)
    .where(eq(audiobooks.userId, fromUserId))) as AudiobookRow[];
  if (books.length === 0) return 0;

  if (isS3Configured()) {
    for (const book of books) {
      await moveAudiobookBlobScope(book.id, fromUserId, toUserId, namespace);
    }
  }

  await db
    .insert(audiobooks)
    .values(books.map((book) => ({ ...book, userId: toUserId })))
    .onConflictDoNothing();

  const chapters = (await db
    .select()
    .from(audiobookChapters)
    .where(eq(audiobookChapters.userId, fromUserId))) as AudiobookChapterRow[];
  if (chapters.length > 0) {
    await db
      .insert(audiobookChapters)
      .values(chapters.map((chapter) => ({ ...chapter, userId: toUserId })))
      .onConflictDoNothing();
  }

  await db.delete(audiobookChapters).where(eq(audiobookChapters.userId, fromUserId));
  await db.delete(audiobooks).where(eq(audiobooks.userId, fromUserId));

  return books.length;
}

export async function transferUserPreferences(fromUserId: string, toUserId: string): Promise<number> {
  if (!isAuthEnabled() || !fromUserId || !toUserId) return 0;
  if (fromUserId === toUserId) return 0;

  const fromRows = (await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, fromUserId))) as UserPreferenceRow[];
  const fromRow = fromRows[0];
  if (!fromRow) return 0;

  const toRows = (await db
    .select()
    .from(userPreferences)
    .where(eq(userPreferences.userId, toUserId))) as UserPreferenceRow[];
  const toRow = toRows[0];

  if (!toRow || Number(fromRow.clientUpdatedAtMs ?? 0) > Number(toRow.clientUpdatedAtMs ?? 0)) {
    await db
      .insert(userPreferences)
      .values({
        ...fromRow,
        userId: toUserId,
      })
      .onConflictDoUpdate({
        target: [userPreferences.userId],
        set: {
          dataJson: fromRow.dataJson,
          clientUpdatedAtMs: fromRow.clientUpdatedAtMs,
          updatedAt: fromRow.updatedAt,
        },
      });
  }

  await db.delete(userPreferences).where(eq(userPreferences.userId, fromUserId));
  return 1;
}

export async function transferUserProgress(fromUserId: string, toUserId: string): Promise<number> {
  if (!isAuthEnabled() || !fromUserId || !toUserId) return 0;
  if (fromUserId === toUserId) return 0;

  const fromRows = (await db
    .select()
    .from(userDocumentProgress)
    .where(eq(userDocumentProgress.userId, fromUserId))) as UserDocumentProgressRow[];
  if (fromRows.length === 0) return 0;

  const documentIds = fromRows.map((row) => row.documentId);
  const toRows = (await db
    .select()
    .from(userDocumentProgress)
    .where(and(
      eq(userDocumentProgress.userId, toUserId),
      inArray(userDocumentProgress.documentId, documentIds),
    ))) as UserDocumentProgressRow[];
  const toByDocId = new Map<string, UserDocumentProgressRow>();
  for (const row of toRows) {
    toByDocId.set(row.documentId, row);
  }

  for (const row of fromRows) {
    const existing = toByDocId.get(row.documentId);
    const fromUpdated = Number(row.clientUpdatedAtMs ?? 0);
    const toUpdated = Number(existing?.clientUpdatedAtMs ?? 0);
    if (existing && fromUpdated <= toUpdated) continue;

    await db
      .insert(userDocumentProgress)
      .values({
        ...row,
        userId: toUserId,
      })
      .onConflictDoUpdate({
        target: [userDocumentProgress.userId, userDocumentProgress.documentId],
        set: {
          readerType: row.readerType,
          location: row.location,
          progress: row.progress,
          clientUpdatedAtMs: row.clientUpdatedAtMs,
          updatedAt: row.updatedAt,
        },
      });
  }

  await db.delete(userDocumentProgress).where(eq(userDocumentProgress.userId, fromUserId));
  return fromRows.length;
}

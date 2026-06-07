import { db } from '@/db';
import {
  documents,
  audiobooks,
  audiobookChapters,
  documentSettings,
  ttsSegmentEntries,
  ttsSegmentVariants,
  userPreferences,
  userDocumentProgress,
} from '@/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { UNCLAIMED_USER_ID } from '../storage/docstore-legacy';
import { cleanupClaimedLegacyFsSources } from './legacy-fs-claim-cleanup';
import {
  deleteAudiobookObject,
  getAudiobookObjectBuffer,
  listAudiobookObjects,
  putAudiobookObject,
} from '../audiobooks/blobstore';
import { isS3Configured } from '../storage/s3';
import { logDegraded } from '../errors/logging';
import { hashForLog, serverLogger } from '../logger';
import { getS3Config } from '../storage/s3';
import { copyTtsSegmentPrefix, deleteTtsSegmentPrefix } from '../tts/segments-blobstore';
import { buildTtsSegmentDocumentPrefix } from '../tts/segments';

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

async function copyAudiobookBlobScope(
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
}

async function deleteAudiobookBlobScope(
  bookId: string,
  userId: string,
  namespace: string | null,
): Promise<void> {
  const objects = await listAudiobookObjects(bookId, userId, namespace);
  for (const object of objects) {
    await deleteAudiobookObject(bookId, userId, object.fileName, namespace);
  }
}

export async function claimAnonymousData(
  userId: string,
  unclaimedUserId: string = UNCLAIMED_USER_ID,
  namespace: string | null = null,
  options?: { cleanupLegacySources?: boolean },
) {
  if (!userId) {
    return { documents: 0, audiobooks: 0, preferences: 0, progress: 0, documentSettings: 0 };
  }

  const [claimableDocumentRows, claimableAudiobookRows] = await Promise.all([
    db
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.userId, unclaimedUserId)) as Promise<Array<{ id: string }>>,
    db
      .select({ id: audiobooks.id })
      .from(audiobooks)
      .where(eq(audiobooks.userId, unclaimedUserId)) as Promise<Array<{ id: string }>>,
  ]);

  const [documentsClaimed, audiobooksClaimed, preferencesClaimed, progressClaimed, documentSettingsClaimed] = await Promise.all([
    transferUserDocuments(unclaimedUserId, userId, { namespace, transferTts: true }),
    transferUserAudiobooks(unclaimedUserId, userId, namespace),
    transferUserPreferences(unclaimedUserId, userId),
    transferUserProgress(unclaimedUserId, userId),
    transferUserDocumentSettings(unclaimedUserId, userId),
  ]);

  if (
    options?.cleanupLegacySources !== false
    && (claimableDocumentRows.length > 0 || claimableAudiobookRows.length > 0)
  ) {
    await cleanupClaimedLegacyFsSources({
      documentIds: claimableDocumentRows.map((row) => row.id),
      audiobookIds: claimableAudiobookRows.map((row) => row.id),
      namespace,
    }).catch((error) => {
      logDegraded(serverLogger, {
        event: 'user.claim.legacy_fs_cleanup.failed',
        msg: 'Failed to remove claimed legacy filesystem sources',
        step: 'cleanup_claimed_legacy_fs_sources',
        context: {
          claimedUserIdHash: hashForLog(userId),
          unclaimedUserIdHash: hashForLog(unclaimedUserId),
          documentCount: claimableDocumentRows.length,
          audiobookCount: claimableAudiobookRows.length,
          namespace,
        },
        error,
      });
    });
  }

  return {
    documents: documentsClaimed,
    audiobooks: audiobooksClaimed,
    preferences: preferencesClaimed,
    progress: progressClaimed,
    documentSettings: documentSettingsClaimed,
  };
}

/**
 * Transfer documents from one userId to another.
 *
 * This is used when an anonymous user upgrades to an authenticated account.
 * The source document blob is shared, while user-scoped TTS metadata and audio
 * are copied before the old ownership is removed.
 *
 * @returns number of document rows transferred
 */
export async function transferUserDocuments(
  fromUserId: string,
  toUserId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: { db?: any; namespace?: string | null; transferTts?: boolean; skipStorage?: boolean },
): Promise<number> {
  if (!fromUserId || !toUserId) return 0;
  if (fromUserId === toUserId) return 0;

  const database = options?.db ?? db;
  // Object storage is always present in a real deployment; `skipStorage` lets
  // tests transfer metadata only. The shared, content-addressed document blob is
  // never touched here — it stays as long as any owner (the new user) remains.
  const copyStorage = !options?.skipStorage && isS3Configured();

  const rows = await database.select().from(documents).where(eq(documents.userId, fromUserId));
  if (rows.length === 0) return 0;

  for (const row of rows) {
    await database
      .insert(documents)
      .values({ ...row, userId: toUserId })
      .onConflictDoNothing();
    if (options?.transferTts) {
      await transferDocumentTtsSegments({
        documentId: row.id,
        fromUserId,
        toUserId,
        namespace: options.namespace ?? null,
        database,
        copyStorage,
      });
    }
    await database.delete(documents).where(and(
      eq(documents.userId, fromUserId),
      eq(documents.id, row.id),
    ));
  }
  return rows.length;
}

async function transferDocumentTtsSegments(input: {
  documentId: string;
  fromUserId: string;
  toUserId: string;
  namespace: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  database: any;
  copyStorage: boolean;
}): Promise<void> {
  // Built only when storage is in play — getS3Config() throws if storage is
  // unconfigured, which is exactly the metadata-only path tests exercise.
  const sourceTtsPrefixes = () => (['v1', 'v2'] as const).map((storageVersion) => ({
    from: buildTtsSegmentDocumentPrefix({
      storagePrefix: getS3Config().prefix,
      namespace: input.namespace,
      userId: input.fromUserId,
      documentId: input.documentId,
      storageVersion,
    }),
    to: buildTtsSegmentDocumentPrefix({
      storagePrefix: getS3Config().prefix,
      namespace: input.namespace,
      userId: input.toUserId,
      documentId: input.documentId,
      storageVersion,
    }),
  }));

  if (input.copyStorage) {
    for (const { from, to } of sourceTtsPrefixes()) {
      await copyTtsSegmentPrefix(from, to);
    }
  }

  const entries = await input.database
    .select()
    .from(ttsSegmentEntries)
    .where(and(
      eq(ttsSegmentEntries.userId, input.fromUserId),
      eq(ttsSegmentEntries.documentId, input.documentId),
    ));
  const variants = entries.length > 0
    ? await input.database
      .select()
      .from(ttsSegmentVariants)
      .where(and(
        eq(ttsSegmentVariants.userId, input.fromUserId),
        inArray(ttsSegmentVariants.segmentEntryId, entries.map(
          (entry: typeof ttsSegmentEntries.$inferSelect) => entry.segmentEntryId,
        )),
      ))
    : [];

  if (entries.length > 0) {
    await input.database.insert(ttsSegmentEntries)
      .values(entries.map((entry: typeof ttsSegmentEntries.$inferSelect) => ({
        ...entry,
        userId: input.toUserId,
      })))
      .onConflictDoNothing();
  }

  const encodedFrom = encodeURIComponent(input.fromUserId);
  const encodedTo = encodeURIComponent(input.toUserId);
  const sourceAudioKeyPrefix = `/users/${encodedFrom}/docs/${input.documentId}/`;
  const destAudioKeyPrefix = `/users/${encodedTo}/docs/${input.documentId}/`;
  if (variants.length > 0) {
    await input.database.insert(ttsSegmentVariants)
      .values(variants.map((variant: typeof ttsSegmentVariants.$inferSelect) => {
        const audioKey = variant.audioKey ?? null;
        if (!audioKey || audioKey.includes(sourceAudioKeyPrefix)) {
          return {
            ...variant,
            userId: input.toUserId,
            audioKey: audioKey?.replace(sourceAudioKeyPrefix, destAudioKeyPrefix) ?? null,
          };
        }
        // The key did not contain the expected source path, so it cannot be
        // safely remapped. Leaving it would point the new owner at the source
        // user's (soon-deleted) audio, so null it out and log for investigation.
        logDegraded(serverLogger, {
          event: 'user.claim.tts_variant_audio_key.unmapped',
          msg: 'TTS segment variant audioKey did not match expected source path during claim',
          step: 'remap_tts_variant_audio_key',
          context: {
            originalAudioKey: audioKey,
            fromUserIdHash: hashForLog(input.fromUserId),
            toUserIdHash: hashForLog(input.toUserId),
            documentId: input.documentId,
          },
        });
        return {
          ...variant,
          userId: input.toUserId,
          audioKey: null,
        };
      }))
      .onConflictDoNothing();
  }

  // Always remove the source metadata: the source account (e.g. the persistent
  // 'unclaimed' user) is not deleted, so nothing would cascade it away.
  if (variants.length > 0) {
    await input.database.delete(ttsSegmentVariants).where(and(
      eq(ttsSegmentVariants.userId, input.fromUserId),
      inArray(ttsSegmentVariants.segmentId, variants.map(
        (variant: typeof ttsSegmentVariants.$inferSelect) => variant.segmentId,
      )),
    ));
  }
  await input.database.delete(ttsSegmentEntries).where(and(
    eq(ttsSegmentEntries.userId, input.fromUserId),
    eq(ttsSegmentEntries.documentId, input.documentId),
  ));

  // Remove the now-copied source audio objects too (only when storage is in play).
  if (input.copyStorage) {
    for (const { from } of sourceTtsPrefixes()) {
      await deleteTtsSegmentPrefix(from);
    }
  }
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
  if (!fromUserId || !toUserId) return 0;
  if (fromUserId === toUserId) return 0;

  const books = (await db
    .select()
    .from(audiobooks)
    .where(eq(audiobooks.userId, fromUserId))) as AudiobookRow[];
  if (books.length === 0) return 0;

  if (isS3Configured()) {
    for (const book of books) {
      await copyAudiobookBlobScope(book.id, fromUserId, toUserId, namespace);
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

  if (isS3Configured()) {
    for (const book of books) {
      await deleteAudiobookBlobScope(book.id, fromUserId, namespace);
    }
  }

  await db.delete(audiobookChapters).where(eq(audiobookChapters.userId, fromUserId));
  await db.delete(audiobooks).where(eq(audiobooks.userId, fromUserId));

  return books.length;
}

export async function transferUserPreferences(fromUserId: string, toUserId: string): Promise<number> {
  if (!fromUserId || !toUserId) return 0;
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
  if (!fromUserId || !toUserId) return 0;
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

export async function transferUserDocumentSettings(
  fromUserId: string,
  toUserId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: { db?: any },
): Promise<number> {
  if (!fromUserId || !toUserId || fromUserId === toUserId) return 0;

  const database = options?.db ?? db;
  const rows = await database
    .select()
    .from(documentSettings)
    .where(eq(documentSettings.userId, fromUserId));
  const documentIds = rows.map((row: { documentId: string }) => row.documentId);
  const existingRows = documentIds.length > 0
    ? await database
      .select({
        documentId: documentSettings.documentId,
        clientUpdatedAtMs: documentSettings.clientUpdatedAtMs,
      })
      .from(documentSettings)
      .where(and(
        eq(documentSettings.userId, toUserId),
        inArray(documentSettings.documentId, documentIds),
      ))
    : [];
  const existingByDocumentId = new Map<string, { clientUpdatedAtMs: number | null }>(
    existingRows.map((row: { documentId: string; clientUpdatedAtMs: number | null }) => [
      row.documentId,
      row,
    ] as const),
  );

  for (const row of rows) {
    const existing = existingByDocumentId.get(row.documentId);
    if (existing && Number(existing.clientUpdatedAtMs ?? 0) >= Number(row.clientUpdatedAtMs ?? 0)) {
      continue;
    }
    await database
      .insert(documentSettings)
      .values({ ...row, userId: toUserId })
      .onConflictDoUpdate({
        target: [documentSettings.documentId, documentSettings.userId],
        set: {
          dataJson: row.dataJson,
          clientUpdatedAtMs: row.clientUpdatedAtMs,
          updatedAt: row.updatedAt,
        },
      });
  }
  await database.delete(documentSettings).where(eq(documentSettings.userId, fromUserId));
  return rows.length;
}

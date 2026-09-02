import { db } from '@openreader/database';
import {
  documents,
  documentSettings,
  userPreferences,
  userDocumentProgress,
  userFolders,
  userOnboarding,
} from '@openreader/database/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { UNCLAIMED_USER_ID } from '../storage/docstore-legacy';
import { cleanupClaimedLegacyFsSources } from './legacy-fs-claim-cleanup';
import { logDegraded } from '../errors/logging';
import { hashForLog, serverLogger } from '../logger';

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

export async function claimAnonymousData(
  userId: string,
  unclaimedUserId: string = UNCLAIMED_USER_ID,
  namespace: string | null = null,
  options?: { cleanupLegacySources?: boolean },
) {
  if (!userId) {
    return { documents: 0, preferences: 0, progress: 0, documentSettings: 0, folders: 0, onboarding: 0 };
  }

  const claimableDocumentRows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.userId, unclaimedUserId)) as Array<{ id: string }>;

  const foldersClaimed = await transferUserFolders(unclaimedUserId, userId);
  const [documentsClaimed, preferencesClaimed, progressClaimed, documentSettingsClaimed, onboardingClaimed] = await Promise.all([
    transferUserDocuments(unclaimedUserId, userId, { namespace }),
    transferUserPreferences(unclaimedUserId, userId),
    transferUserProgress(unclaimedUserId, userId),
    transferUserDocumentSettings(unclaimedUserId, userId),
    transferUserOnboarding(unclaimedUserId, userId),
  ]);
  await db.delete(userFolders).where(eq(userFolders.userId, unclaimedUserId));

  if (
    options?.cleanupLegacySources !== false
    && claimableDocumentRows.length > 0
  ) {
    await cleanupClaimedLegacyFsSources({
      documentIds: claimableDocumentRows.map((row) => row.id),
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
          namespace,
        },
        error,
      });
    });
  }

  return {
    documents: documentsClaimed,
    preferences: preferencesClaimed,
    progress: progressClaimed,
    documentSettings: documentSettingsClaimed,
    folders: foldersClaimed,
    onboarding: onboardingClaimed,
  };
}

export async function transferUserFolders(fromUserId: string, toUserId: string): Promise<number> {
  if (!fromUserId || !toUserId || fromUserId === toUserId) return 0;
  const rows = await db.select().from(userFolders).where(eq(userFolders.userId, fromUserId));
  for (const row of rows) {
    await db.insert(userFolders).values({ ...row, userId: toUserId }).onConflictDoNothing();
  }
  return rows.length;
}

export async function transferUserOnboarding(fromUserId: string, toUserId: string): Promise<number> {
  if (!fromUserId || !toUserId || fromUserId === toUserId) return 0;
  const rows = await db.select().from(userOnboarding).where(eq(userOnboarding.userId, fromUserId));
  const row = rows[0];
  if (!row) return 0;
  await db.insert(userOnboarding).values({ ...row, userId: toUserId }).onConflictDoNothing();
  await db.delete(userOnboarding).where(eq(userOnboarding.userId, fromUserId));
  return 1;
}

/**
 * Transfer documents from one userId to another.
 *
 * This is used when an anonymous user upgrades to an authenticated account.
 * The source document blob is shared. TTS playback artifacts are session-scoped
 * in worker storage and are intentionally not transferred between users.
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
  const rows = await database.select().from(documents).where(eq(documents.userId, fromUserId));
  if (rows.length === 0) return 0;

  for (const row of rows) {
    await database
      .insert(documents)
      .values({ ...row, userId: toUserId })
      .onConflictDoNothing();
    await database.delete(documents).where(and(
      eq(documents.userId, fromUserId),
      eq(documents.id, row.id),
    ));
  }
  return rows.length;
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

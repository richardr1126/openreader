import { and, count, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '@openreader/database';
import { runInDbTransaction } from '@openreader/database/run-in-transaction';
import { documents, documentAudioUsage } from '@openreader/database/schema';
import * as sqlite from '@openreader/database/schema-auth-sqlite';
import * as postgres from '@openreader/database/schema-auth-postgres';
import { getRuntimeConfig, type RuntimeConfig } from '@/lib/server/admin/settings';
import type { ComputeLimitSubject } from '@/lib/server/compute-limits/policy';
import { ApiRequestError } from '@/lib/server/api/responses';

const { user } = process.env.POSTGRES_URL ? postgres : sqlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const database = () => db as any;
export type StorageUsage = {
  documentBytes: number; audioBytes: number; totalBytes: number; documentCount: number;
  orphanedAudioBytes: number; orphanedDocumentCount: number;
};

/** The sole SQL aggregation used by settings, the user directory and caps. */
export async function getStorageUsage(userIds: string[] | 'guests', connection = database()): Promise<Map<string, StorageUsage>> {
  const database = connection;
  const empty = (): StorageUsage => ({ documentBytes: 0, audioBytes: 0, totalBytes: 0, documentCount: 0, orphanedAudioBytes: 0, orphanedDocumentCount: 0 });
  const result = new Map((userIds === 'guests' ? [] : userIds).map((id) => [id, empty()]));
  if (userIds !== 'guests' && !userIds.length) return result;
  const ids = userIds === 'guests' ? database.select({ id: user.id }).from(user).where(eq(user.isAnonymous, true)) : userIds;
  const [sources, audio] = await Promise.all([
    database.select({ userId: documents.userId, documentBytes: sql`coalesce(sum(${documents.size}), 0)`, documentCount: count() })
      .from(documents).where(inArray(documents.userId, ids)).groupBy(documents.userId),
    database.select({ userId: documentAudioUsage.userId, audioBytes: sql`coalesce(sum(${documentAudioUsage.audioBytes}), 0)`,
      orphanedAudioBytes: sql`coalesce(sum(case when ${documents.id} is null then ${documentAudioUsage.audioBytes} else 0 end), 0)`,
      orphanedDocumentCount: sql`coalesce(sum(case when ${documents.id} is null and ${documentAudioUsage.audioBytes} > 0 then 1 else 0 end), 0)` })
      .from(documentAudioUsage).leftJoin(documents, and(eq(documents.id, documentAudioUsage.documentId), eq(documents.userId, documentAudioUsage.userId)))
      .where(inArray(documentAudioUsage.userId, ids)).groupBy(documentAudioUsage.userId),
  ]);
  for (const row of [...sources, ...audio]) {
    if (!result.has(row.userId)) result.set(row.userId, empty());
    for (const key of ['documentBytes', 'documentCount', 'audioBytes', 'orphanedAudioBytes', 'orphanedDocumentCount'] as const) {
      if (row[key] !== undefined) result.get(row.userId)![key] = Number(row[key]);
    }
  }
  for (const usage of result.values()) usage.totalBytes = usage.documentBytes + usage.audioBytes;
  return result;
}

export function storageCapBytes(config: RuntimeConfig, isAnonymous: boolean): number | null {
  return isAnonymous ? config.limitGuestStorage ? config.guestStorageMb * 1_048_576 : null
    : config.limitAccountStorage ? config.accountStorageMb * 1_048_576 : null;
}

export async function storageLimit(subject: ComputeLimitSubject, additionalBytes = 0, config?: RuntimeConfig, connection = database()): Promise<{ code: string; message: string } | null> {
  config ??= await getRuntimeConfig();
  const cap = storageCapBytes(config, subject.isAnonymous);
  if (cap !== null) {
    const usage = (await getStorageUsage([subject.userId], connection)).get(subject.userId)!;
    if (additionalBytes ? usage.totalBytes + additionalBytes > cap : usage.totalBytes >= cap) return {
      code: subject.isAnonymous ? 'GUEST_STORAGE_LIMIT_REACHED' : 'ACCOUNT_STORAGE_LIMIT_REACHED',
      message: subject.isAnonymous ? 'Guest storage limit reached.' : 'Account storage limit reached.',
    };
  }
  if (subject.isAnonymous && config.limitGuestStoragePool) {
    const total = [...(await getStorageUsage('guests', connection)).values()].reduce((sum, usage) => sum + usage.totalBytes, 0);
    const poolCap = config.guestStoragePoolMb * 1_048_576;
    if (additionalBytes ? total + additionalBytes > poolCap : total >= poolCap) return { code: 'GUEST_STORAGE_POOL_FULL', message: 'Total guest storage limit reached.' };
  }
  return null;
}

export async function assertStorageAvailable(subject: ComputeLimitSubject, bytes: number, config?: RuntimeConfig): Promise<void> {
  const limit = await storageLimit(subject, bytes, config);
  if (limit) throw new ApiRequestError(429, limit.code, `${limit.message} Free space in Storage (/app/settings?section=storage).${subject.isAnonymous ? ' You can also create an account (/signup).' : ''}`, 60_000);
}

/** Recheck at registration so concurrent prepared uploads cannot bypass a cap. */
export async function withStorageRegistration<T>(input: { userId: string; documentId: string; size: number }, write: (connection: ReturnType<typeof database>) => Promise<T>): Promise<T> {
  const config = await getRuntimeConfig();
  if (!config.limitAccountStorage && !config.limitGuestStorage && !config.limitGuestStoragePool) return write(database());
  return runInDbTransaction(async (conn) => {
    const [owner] = await conn.update(user).set({ updatedAt: sql`${user.updatedAt}` }).where(eq(user.id, input.userId)).returning({ isAnonymous: user.isAnonymous });
    if (!owner) throw new ApiRequestError(404, 'ACCOUNT_NOT_FOUND', 'Account not found.');
    const subject = { userId: input.userId, isAnonymous: Boolean(owner.isAnonymous) };
    if (subject.isAnonymous && config.limitGuestStoragePool && process.env.POSTGRES_URL) {
      // SQLite's BEGIN IMMEDIATE already serializes the shared pool. This
      // transaction-scoped PostgreSQL key is distinct from the admin lock.
      await conn.execute(sql`select pg_advisory_xact_lock(4915231002)`);
    }
    const [existing] = await conn.select({ size: documents.size }).from(documents).where(and(eq(documents.userId, input.userId), eq(documents.id, input.documentId))).limit(1);
    const growth = Math.max(0, input.size - Number(existing?.size ?? 0));
    const blocked = growth ? await storageLimit(subject, growth, config, conn) : null;
    if (blocked) throw new ApiRequestError(429, blocked.code, `${blocked.message} Free space in Storage (/app/settings?section=storage).${subject.isAnonymous ? ' You can also create an account (/signup).' : ''}`, 60_000);
    return write(conn);
  });
}

/** App-issued revisions fence delayed/out-of-order reports, including across clears. */
export async function beginAudioMeasurement(userId: string, documentId: string, clearing = false): Promise<number | null> {
  return runInDbTransaction(async (conn) => {
    const [owner] = await conn.select({ id: user.id }).from(user).where(and(eq(user.id, userId), isNull(user.deletionRequestedAt))).limit(1);
    if (!owner) return null;
    const now = Date.now();
    await conn.insert(documentAudioUsage).values({ userId, documentId }).onConflictDoNothing();
    const rows = await conn.update(documentAudioUsage).set({ revision: sql`${documentAudioUsage.revision} + 1`, clearLeaseUntil: clearing ? now + 120_000 : 0 })
      .where(and(eq(documentAudioUsage.userId, userId), eq(documentAudioUsage.documentId, documentId), clearing ? undefined : lte(documentAudioUsage.clearLeaseUntil, now)))
      .returning({ revision: documentAudioUsage.revision });
    return rows[0] ? Number(rows[0].revision) : null;
  });
}

export async function reportAudioMeasurement(input: { userId: string; documentId: string; revision: number; audioBytes: number }): Promise<void> {
  // UPDATE only: a report cannot recreate a deleted account/usage row.
  await database().update(documentAudioUsage).set({ audioBytes: input.audioBytes, measuredAt: Date.now(), clearLeaseUntil: 0 })
    .where(and(eq(documentAudioUsage.userId, input.userId), eq(documentAudioUsage.documentId, input.documentId), eq(documentAudioUsage.revision, input.revision)));
}

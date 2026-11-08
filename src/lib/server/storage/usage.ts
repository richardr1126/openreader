import { and, count, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { STORAGE_LIMIT_MESSAGES, type StorageLimitCode } from '@openreader/runtime-config/compute-limit-broker';
import { db } from '@openreader/database';
import { runInDbTransaction } from '@openreader/database/run-in-transaction';
import { documents, documentAudioUsage } from '@openreader/database/schema';
import * as sqlite from '@openreader/database/schema-auth-sqlite';
import * as postgres from '@openreader/database/schema-auth-postgres';
import { getRuntimeConfig, type RuntimeConfig } from '@/lib/server/admin/settings';
import type { ComputeLimitSubject } from '@/lib/server/compute-limits/policy';
import { ApiRequestError } from '@/lib/server/api/responses';
import { WORKER_STORAGE_TIMEOUT_MS } from '@/lib/server/compute-worker/protocol';

const { user } = process.env.POSTGRES_URL ? postgres : sqlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const database = () => db as any;
export type StorageUsage = {
  documentBytes: number; audioBytes: number; totalBytes: number; documentCount: number;
  orphanedAudioBytes: number; orphanedDocumentCount: number;
};
export type StorageLimit = { code: StorageLimitCode; message: string };

/** The sole per-user SQL aggregation used by settings, the user directory and caps. */
export async function getStorageUsage(userIds: string[], connection = database()): Promise<Map<string, StorageUsage>> {
  const result = new Map<string, StorageUsage>(userIds.map((id) => [id, {
    documentBytes: 0, audioBytes: 0, totalBytes: 0, documentCount: 0, orphanedAudioBytes: 0, orphanedDocumentCount: 0,
  }]));
  if (!userIds.length) return result;
  const [sources, audio] = await Promise.all([
    connection.select({ userId: documents.userId, documentBytes: sql`coalesce(sum(${documents.size}), 0)`, documentCount: count() })
      .from(documents).where(inArray(documents.userId, userIds)).groupBy(documents.userId),
    connection.select({ userId: documentAudioUsage.userId, audioBytes: sql`coalesce(sum(${documentAudioUsage.audioBytes}), 0)`,
      orphanedAudioBytes: sql`coalesce(sum(case when ${documents.id} is null then ${documentAudioUsage.audioBytes} else 0 end), 0)`,
      orphanedDocumentCount: sql`coalesce(sum(case when ${documents.id} is null and ${documentAudioUsage.audioBytes} > 0 then 1 else 0 end), 0)` })
      .from(documentAudioUsage).leftJoin(documents, and(eq(documents.id, documentAudioUsage.documentId), eq(documents.userId, documentAudioUsage.userId)))
      .where(inArray(documentAudioUsage.userId, userIds)).groupBy(documentAudioUsage.userId),
  ]);
  for (const row of sources) Object.assign(result.get(row.userId)!, { documentBytes: Number(row.documentBytes), documentCount: Number(row.documentCount) });
  for (const row of audio) Object.assign(result.get(row.userId)!, { audioBytes: Number(row.audioBytes),
    orphanedAudioBytes: Number(row.orphanedAudioBytes), orphanedDocumentCount: Number(row.orphanedDocumentCount) });
  for (const usage of result.values()) usage.totalBytes = usage.documentBytes + usage.audioBytes;
  return result;
}

/** One sum for the shared pool: this runs on usage checks, so it must not load every guest. */
async function getGuestStorageBytes(connection: ReturnType<typeof database>): Promise<number> {
  const guests = connection.select({ id: user.id }).from(user).where(eq(user.isAnonymous, true));
  const [[sources], [audio]] = await Promise.all([
    connection.select({ bytes: sql`coalesce(sum(${documents.size}), 0)` }).from(documents).where(inArray(documents.userId, guests)),
    connection.select({ bytes: sql`coalesce(sum(${documentAudioUsage.audioBytes}), 0)` }).from(documentAudioUsage).where(inArray(documentAudioUsage.userId, guests)),
  ]);
  return Number(sources.bytes) + Number(audio.bytes);
}

export function storageCapBytes(config: RuntimeConfig, isAnonymous: boolean): number | null {
  if (isAnonymous) return config.limitGuestStorage ? config.guestStorageMb * 1_048_576 : null;
  return config.limitAccountStorage ? config.accountStorageMb * 1_048_576 : null;
}

const blockedBy = (code: StorageLimitCode): StorageLimit => ({ code, message: STORAGE_LIMIT_MESSAGES[code] });

/** With no added bytes, a total exactly at the cap blocks new work. */
export async function storageLimit(subject: ComputeLimitSubject, additionalBytes = 0, config?: RuntimeConfig, connection = database()): Promise<StorageLimit | null> {
  config ??= await getRuntimeConfig();
  const exceeds = (used: number, cap: number) => additionalBytes ? used + additionalBytes > cap : used >= cap;
  const cap = storageCapBytes(config, subject.isAnonymous);
  if (cap !== null) {
    const usage = (await getStorageUsage([subject.userId], connection)).get(subject.userId)!;
    if (exceeds(usage.totalBytes, cap)) return blockedBy(subject.isAnonymous ? 'GUEST_STORAGE_LIMIT_REACHED' : 'ACCOUNT_STORAGE_LIMIT_REACHED');
  }
  if (subject.isAnonymous && config.limitGuestStoragePool
    && exceeds(await getGuestStorageBytes(connection), config.guestStoragePoolMb * 1_048_576)) return blockedBy('GUEST_STORAGE_POOL_FULL');
  return null;
}

const storageLimitError = ({ code, message }: StorageLimit) => new ApiRequestError(429, code, message, 60_000);

export async function assertStorageAvailable(subject: ComputeLimitSubject, bytes: number, config?: RuntimeConfig): Promise<void> {
  const limit = await storageLimit(subject, bytes, config);
  if (limit) throw storageLimitError(limit);
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
    if (blocked) throw storageLimitError(blocked);
    return write(conn);
  });
}

/** Documents with measured audio, including ones whose source document is gone. */
export async function listAudioDocumentIds(userId: string): Promise<string[]> {
  const rows: Array<{ documentId: string }> = await database().select({ documentId: documentAudioUsage.documentId }).from(documentAudioUsage)
    .where(and(eq(documentAudioUsage.userId, userId), gt(documentAudioUsage.audioBytes, 0)));
  return rows.map((row) => row.documentId);
}

/** App-issued revisions fence delayed/out-of-order reports, including across clears. */
// A clear can run as long as the app waits for it, so a measurement taken mid-clear can't land after it.
const CLEAR_LEASE_MS = WORKER_STORAGE_TIMEOUT_MS + 60_000;
export async function beginAudioMeasurement(userId: string, documentId: string, clearing = false): Promise<number | null> {
  return runInDbTransaction(async (conn) => {
    const [owner] = await conn.select({ id: user.id }).from(user).where(and(eq(user.id, userId), isNull(user.deletionRequestedAt))).limit(1);
    if (!owner) return null;
    const now = Date.now();
    await conn.insert(documentAudioUsage).values({ userId, documentId }).onConflictDoNothing();
    const rows = await conn.update(documentAudioUsage).set({ revision: sql`${documentAudioUsage.revision} + 1`, clearLeaseUntil: clearing ? now + CLEAR_LEASE_MS : 0 })
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

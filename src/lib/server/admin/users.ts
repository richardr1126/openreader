import { and, asc, count, desc, eq, inArray, isNotNull, isNull, like, max, or, sql } from 'drizzle-orm';
import { db } from '@openreader/database';
import { runInDbTransaction } from '@openreader/database/run-in-transaction';
import { computeLimitEvents, documents } from '@openreader/database/schema';
import * as authSchemaSqlite from '@openreader/database/schema-auth-sqlite';
import * as authSchemaPostgres from '@openreader/database/schema-auth-postgres';
import { deleteUserStorageData } from '@/lib/server/user/data-cleanup';
import { hashForLog, serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';

const authSchema = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;
const { user, session } = authSchema;
// The selected auth schema is a runtime dialect union. Drizzle cannot express
// that union statically, while every query below uses columns shared by both.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const database = db as any;

// Every admin-removal path (demote, suspend, delete, and the Better Auth
// self-delete guard) serializes on this one advisory lock so the last-admin
// count and the mutation that acts on it stay atomic. The constant is
// arbitrary but must be stable across processes.
const ADMIN_MUTATION_LOCK_KEY = 4915231001;

/**
 * Run `fn` inside a transaction that holds the shared admin-mutation lock.
 * On Postgres a transaction-scoped advisory lock serializes across app
 * instances; on SQLite the dedicated BEGIN IMMEDIATE connection already
 * serializes every such transaction globally.
 */
async function withAdminMutationLock<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (conn: any) => Promise<T>,
): Promise<T> {
  return runInDbTransaction(async (conn) => {
    if (process.env.POSTGRES_URL) {
      await conn.execute(sql.raw(`SELECT pg_advisory_xact_lock(${ADMIN_MUTATION_LOCK_KEY})`));
    }
    return fn(conn);
  });
}

export type UserAccessStatus = 'active' | 'pending' | 'suspended';
export type AdminUserKindFilter = 'all' | 'account' | 'anonymous';
export type AdminUserStatusFilter = 'all' | UserAccessStatus;

export interface AdminUserSummary {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  isAnonymous: boolean;
  isAdmin: boolean;
  adminSource: 'bootstrap' | 'managed' | 'none';
  accessStatus: UserAccessStatus;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string | null;
  sessionCount: number;
  documentCount: number;
  documentBytes: number;
  usage: {
    ttsCharacters: number;
    inputBytes: number;
    files: number;
  };
}

export interface AdminUsersPage {
  users: AdminUserSummary[];
  total: number;
  page: number;
  pageSize: number;
  counts: {
    all: number;
    accounts: number;
    anonymous: number;
    pending: number;
    suspended: number;
    admins: number;
  };
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value as string | number);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function normalizeAccessStatus(value: unknown): UserAccessStatus {
  return value === 'pending' || value === 'suspended' ? value : 'active';
}

function numeric(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function listAdminUsers(input: {
  page?: number;
  pageSize?: number;
  search?: string;
  kind?: AdminUserKindFilter;
  status?: AdminUserStatusFilter;
} = {}): Promise<AdminUsersPage> {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize ?? 25)));
  const search = input.search?.trim().slice(0, 200) ?? '';
  const kind = input.kind ?? 'all';
  const status = input.status ?? 'all';
  const conditions = [];
  if (search) {
    const pattern = `%${search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    conditions.push(or(like(user.email, pattern), like(user.name, pattern)));
  }
  if (kind === 'anonymous') conditions.push(eq(user.isAnonymous, true));
  if (kind === 'account') conditions.push(or(eq(user.isAnonymous, false), isNull(user.isAnonymous)));
  if (status !== 'all') conditions.push(eq(user.accessStatus, status));
  const where = conditions.length === 0 ? undefined : and(...conditions);

  const [totalRows, rawUsers, classificationRows] = await Promise.all([
    database.select({ value: count() }).from(user).where(where),
    database.select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      isAnonymous: user.isAnonymous,
      isAdmin: user.isAdmin,
      adminSource: user.adminSource,
      accessStatus: user.accessStatus,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    }).from(user).where(where).orderBy(desc(user.createdAt), asc(user.id)).limit(pageSize).offset((page - 1) * pageSize),
    database.select({
      isAnonymous: user.isAnonymous,
      isAdmin: user.isAdmin,
      accessStatus: user.accessStatus,
      value: count(),
    }).from(user).groupBy(user.isAnonymous, user.isAdmin, user.accessStatus),
  ]) as [Array<{ value: number }>, Array<Record<string, unknown>>, Array<Record<string, unknown>>];

  const ids = rawUsers.map((entry) => String(entry.id));
  const [documentRows, sessionRows, usageRows] = ids.length === 0
    ? [[], [], []]
    : await Promise.all([
      database.select({
        userId: documents.userId,
        documentCount: count(),
        documentBytes: sql<number>`coalesce(sum(${documents.size}), 0)`,
      }).from(documents).where(inArray(documents.userId, ids)).groupBy(documents.userId),
      database.select({
        userId: session.userId,
        sessionCount: count(),
        lastActiveAt: max(session.updatedAt),
      }).from(session).where(inArray(session.userId, ids)).groupBy(session.userId),
      database.select({
        userId: computeLimitEvents.userId,
        metric: computeLimitEvents.metric,
        units: sql<number>`coalesce(sum(${computeLimitEvents.units}), 0)`,
      }).from(computeLimitEvents).where(inArray(computeLimitEvents.userId, ids))
        .groupBy(computeLimitEvents.userId, computeLimitEvents.metric),
    ]) as [Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>];

  const documentsByUser = new Map(documentRows.map((row) => [String(row.userId), row]));
  const sessionsByUser = new Map(sessionRows.map((row) => [String(row.userId), row]));
  const usageByUser = new Map<string, AdminUserSummary['usage']>();
  for (const row of usageRows) {
    const userId = String(row.userId);
    const usage = usageByUser.get(userId) ?? { ttsCharacters: 0, inputBytes: 0, files: 0 };
    if (row.metric === 'characters') usage.ttsCharacters += numeric(row.units);
    if (row.metric === 'input_bytes') usage.inputBytes += numeric(row.units);
    if (row.metric === 'files') usage.files += numeric(row.units);
    usageByUser.set(userId, usage);
  }

  const counts = classificationRows.reduce<AdminUsersPage['counts']>((result, row) => {
    const value = numeric(row.value);
    result.all += value;
    if (row.isAnonymous) result.anonymous += value;
    else result.accounts += value;
    if (row.isAdmin) result.admins += value;
    if (row.accessStatus === 'pending') result.pending += value;
    if (row.accessStatus === 'suspended') result.suspended += value;
    return result;
  }, { all: 0, accounts: 0, anonymous: 0, pending: 0, suspended: 0, admins: 0 });

  return {
    users: rawUsers.map((row) => {
      const id = String(row.id);
      const document = documentsByUser.get(id);
      const activeSession = sessionsByUser.get(id);
      return {
        id,
        name: String(row.name ?? ''),
        email: String(row.email ?? ''),
        emailVerified: Boolean(row.emailVerified),
        isAnonymous: Boolean(row.isAnonymous),
        isAdmin: Boolean(row.isAdmin),
        adminSource: row.adminSource === 'bootstrap' || row.adminSource === 'managed' ? row.adminSource : 'none',
        accessStatus: normalizeAccessStatus(row.accessStatus),
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
        lastActiveAt: activeSession?.lastActiveAt ? iso(activeSession.lastActiveAt) : null,
        sessionCount: numeric(activeSession?.sessionCount),
        documentCount: numeric(document?.documentCount),
        documentBytes: numeric(document?.documentBytes),
        usage: usageByUser.get(id) ?? { ttsCharacters: 0, inputBytes: 0, files: 0 },
      };
    }),
    total: numeric(totalRows[0]?.value),
    page,
    pageSize,
    counts,
  };
}

interface TargetUser {
  id: string;
  isAnonymous: boolean;
  isAdmin: boolean;
  accessStatus: UserAccessStatus;
  deletionRequestedAt: Date | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getTargetUser(userId: string, conn: any = database): Promise<TargetUser | null> {
  const rows = await conn.select({
    id: user.id,
    isAnonymous: user.isAnonymous,
    isAdmin: user.isAdmin,
    accessStatus: user.accessStatus,
    deletionRequestedAt: user.deletionRequestedAt,
  }).from(user).where(eq(user.id, userId)).limit(1) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  const requestedAt = row.deletionRequestedAt;
  return {
    id: String(row.id),
    isAnonymous: Boolean(row.isAnonymous),
    isAdmin: Boolean(row.isAdmin),
    accessStatus: normalizeAccessStatus(row.accessStatus),
    deletionRequestedAt: requestedAt == null ? null : new Date(requestedAt as string | number | Date),
  };
}

/**
 * Throw if `target` is the final removable administrator. Runs on the caller's
 * connection so it can be part of the same transaction as the mutation it
 * guards; `assertNotLastAdmin` is the standalone (self-locking) entry point.
 */
async function assertNotLastAdminOn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conn: any,
  target: { isAdmin: boolean; accessStatus: UserAccessStatus },
): Promise<void> {
  if (!target.isAdmin) return;
  const rows = await conn.select({ value: count() }).from(user).where(
    target.accessStatus === 'active'
      ? and(eq(user.isAdmin, true), eq(user.accessStatus, 'active'))
      : eq(user.isAdmin, true),
  ) as Array<{ value: number }>;
  if (numeric(rows[0]?.value) <= 1) {
    throw new AdminUserManagementError('The final administrator cannot be removed.', 409);
  }
}

export async function assertNotLastAdmin(target: { isAdmin: boolean; accessStatus: UserAccessStatus }): Promise<void> {
  if (!target.isAdmin) return;
  await withAdminMutationLock((conn) => assertNotLastAdminOn(conn, target));
}

export class AdminUserManagementError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function updateManagedUser(input: {
  actorUserId: string;
  targetUserId: string;
  isAdmin?: boolean;
  accessStatus?: UserAccessStatus;
}): Promise<void> {
  // Identity-only checks do not depend on live table state, so reject early.
  if (input.targetUserId === input.actorUserId && input.isAdmin === false) {
    throw new AdminUserManagementError('You cannot remove your own administrator access.', 409);
  }
  if (input.targetUserId === input.actorUserId && input.accessStatus && input.accessStatus !== 'active') {
    throw new AdminUserManagementError('You cannot suspend your own account.', 409);
  }

  // The target read, last-admin guard, and mutation share one locked
  // transaction so the count cannot go stale between check and write.
  await withAdminMutationLock(async (conn) => {
    const target = await getTargetUser(input.targetUserId, conn);
    if (!target) throw new AdminUserManagementError('User not found.', 404);
    if (target.isAnonymous && (input.isAdmin !== undefined || input.accessStatus !== undefined)) {
      throw new AdminUserManagementError('Anonymous users cannot receive account roles or approval state.', 400);
    }
    if (input.isAdmin === true && (target.accessStatus !== 'active'
      || (input.accessStatus !== undefined && input.accessStatus !== 'active'))) {
      throw new AdminUserManagementError('Approve or restore the account before granting administrator access.', 409);
    }
    if ((input.isAdmin === false || (input.accessStatus && input.accessStatus !== 'active')) && target.isAdmin) {
      await assertNotLastAdminOn(conn, target);
    }

    const updates: Record<string, unknown> = {};
    if (input.isAdmin !== undefined) {
      updates.isAdmin = input.isAdmin;
      updates.adminSource = input.isAdmin ? 'managed' : 'none';
    }
    if (input.accessStatus !== undefined) updates.accessStatus = input.accessStatus;
    if (Object.keys(updates).length === 0) return;

    await conn.update(user).set(updates).where(eq(user.id, input.targetUserId));
    await conn.delete(session).where(eq(session.userId, input.targetUserId));
  });
}

export async function deleteManagedUser(input: {
  actorUserId: string;
  targetUserId: string;
}): Promise<void> {
  if (input.actorUserId === input.targetUserId) {
    throw new AdminUserManagementError('Use Account settings to delete your own account.', 409);
  }
  // Phase 1 durably records the intent (atomic with the last-admin guard);
  // phase 2 performs the irreversible storage + row cleanup. If phase 2 fails
  // the marker survives, so the request is retryable and the startup sweep
  // (`resumePendingUserDeletions`) finishes it.
  await requestUserDeletion(input.targetUserId);
  await finalizeUserDeletion(input.targetUserId);
}

/**
 * Phase 1: guard against removing the last admin, then durably mark the
 * account for deletion — suspend it, stamp `deletionRequestedAt`, and revoke
 * sessions — all inside one locked transaction. Idempotent: re-marking an
 * already-marked account skips the guard so a resumed deletion can proceed.
 */
async function requestUserDeletion(targetUserId: string): Promise<void> {
  await withAdminMutationLock(async (conn) => {
    const target = await getTargetUser(targetUserId, conn);
    if (!target) throw new AdminUserManagementError('User not found.', 404);
    if (target.deletionRequestedAt === null && target.isAdmin) {
      await assertNotLastAdminOn(conn, target);
    }
    await conn.update(user)
      .set({ accessStatus: 'suspended', deletionRequestedAt: new Date() })
      .where(eq(user.id, target.id));
    await conn.delete(session).where(eq(session.userId, target.id));
  });
}

/**
 * Phase 2: remove user-owned storage, then the account row. Both steps are
 * idempotent — storage cleanup fails safe (throws before the row is removed),
 * and a missing row is a completed deletion.
 */
async function finalizeUserDeletion(targetUserId: string): Promise<void> {
  await deleteUserStorageData(targetUserId, null);
  await database.delete(user).where(eq(user.id, targetUserId));
}

/**
 * Startup sweep: complete any deletion whose durable marker survived a crash
 * or a transient storage-cleanup failure. Per-account errors are logged and
 * skipped so one stuck account cannot block the rest (or startup).
 */
export async function resumePendingUserDeletions(): Promise<void> {
  const rows = await database.select({ id: user.id }).from(user)
    .where(isNotNull(user.deletionRequestedAt)) as Array<{ id: string }>;
  if (rows.length === 0) return;
  serverLogger.info({
    event: 'admin.user_delete.resume_sweep',
    count: rows.length,
  }, `Resuming ${rows.length} pending user deletion(s)`);
  for (const row of rows) {
    const targetUserId = String(row.id);
    try {
      await finalizeUserDeletion(targetUserId);
    } catch (error) {
      logDegraded(serverLogger, {
        event: 'admin.user_delete.resume_failed',
        msg: 'Failed to finish a pending user deletion; will retry on next sweep',
        step: 'finalize_user_deletion',
        context: { userIdHash: hashForLog(targetUserId) },
        error,
      });
    }
  }
}

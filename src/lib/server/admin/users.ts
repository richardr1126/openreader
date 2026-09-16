import { and, asc, count, desc, eq, inArray, isNull, like, max, or, sql } from 'drizzle-orm';
import { db } from '@openreader/database';
import { computeLimitEvents, documents } from '@openreader/database/schema';
import * as authSchemaSqlite from '@openreader/database/schema-auth-sqlite';
import * as authSchemaPostgres from '@openreader/database/schema-auth-postgres';
import { deleteUserStorageData } from '@/lib/server/user/data-cleanup';

const authSchema = process.env.POSTGRES_URL ? authSchemaPostgres : authSchemaSqlite;
const { user, session } = authSchema;
// The selected auth schema is a runtime dialect union. Drizzle cannot express
// that union statically, while every query below uses columns shared by both.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const database = db as any;

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

async function getTargetUser(userId: string): Promise<{
  id: string;
  isAnonymous: boolean;
  isAdmin: boolean;
  accessStatus: UserAccessStatus;
} | null> {
  const rows = await database.select({
    id: user.id,
    isAnonymous: user.isAnonymous,
    isAdmin: user.isAdmin,
    accessStatus: user.accessStatus,
  }).from(user).where(eq(user.id, userId)).limit(1) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    isAnonymous: Boolean(row.isAnonymous),
    isAdmin: Boolean(row.isAdmin),
    accessStatus: normalizeAccessStatus(row.accessStatus),
  };
}

export async function assertNotLastAdmin(target: { isAdmin: boolean; accessStatus: UserAccessStatus }): Promise<void> {
  if (!target.isAdmin) return;
  const rows = await database.select({ value: count() }).from(user).where(
    target.accessStatus === 'active'
      ? and(eq(user.isAdmin, true), eq(user.accessStatus, 'active'))
      : eq(user.isAdmin, true),
  ) as Array<{ value: number }>;
  if (numeric(rows[0]?.value) <= 1) {
    throw new AdminUserManagementError('The final administrator cannot be removed.', 409);
  }
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
  const target = await getTargetUser(input.targetUserId);
  if (!target) throw new AdminUserManagementError('User not found.', 404);
  if (target.isAnonymous && (input.isAdmin !== undefined || input.accessStatus !== undefined)) {
    throw new AdminUserManagementError('Anonymous users cannot receive account roles or approval state.', 400);
  }
  if (input.targetUserId === input.actorUserId && input.isAdmin === false) {
    throw new AdminUserManagementError('You cannot remove your own administrator access.', 409);
  }
  if (input.targetUserId === input.actorUserId && input.accessStatus && input.accessStatus !== 'active') {
    throw new AdminUserManagementError('You cannot suspend your own account.', 409);
  }
  if (input.isAdmin === true && (target.accessStatus !== 'active'
    || (input.accessStatus !== undefined && input.accessStatus !== 'active'))) {
    throw new AdminUserManagementError('Approve or restore the account before granting administrator access.', 409);
  }
  if ((input.isAdmin === false || (input.accessStatus && input.accessStatus !== 'active')) && target.isAdmin) {
    await assertNotLastAdmin(target);
  }

  const updates: Record<string, unknown> = {};
  if (input.isAdmin !== undefined) {
    updates.isAdmin = input.isAdmin;
    updates.adminSource = input.isAdmin ? 'managed' : 'none';
  }
  if (input.accessStatus !== undefined) updates.accessStatus = input.accessStatus;
  if (Object.keys(updates).length === 0) return;

  await database.update(user).set(updates).where(eq(user.id, input.targetUserId));
  await database.delete(session).where(eq(session.userId, input.targetUserId));
}

export async function deleteManagedUser(input: {
  actorUserId: string;
  targetUserId: string;
}): Promise<void> {
  if (input.actorUserId === input.targetUserId) {
    throw new AdminUserManagementError('Use Account settings to delete your own account.', 409);
  }
  const target = await getTargetUser(input.targetUserId);
  if (!target) throw new AdminUserManagementError('User not found.', 404);
  if (target.isAdmin) await assertNotLastAdmin(target);
  await deleteUserStorageData(target.id, null);
  await database.delete(user).where(eq(user.id, target.id));
}

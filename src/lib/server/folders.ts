import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents, userFolders } from '@openreader/database/schema';
import { runInDbTransaction } from '@openreader/database/run-in-transaction';
import type { ApiPrincipal } from './api/principal';
import { ApiRequestError } from './api/responses';
import { nowTimestampMs } from '@/lib/shared/timestamps';
import type { FolderResource } from '@/types/folder-api';

const createdAt = sql<number>`coalesce(${userFolders.createdAt}, 0)`.mapWith(Number);
const fields = { id: userFolders.id, name: userFolders.name, position: userFolders.position,
  createdAt, updatedAt: sql<number>`coalesce(${userFolders.updatedAt}, 0)`.mapWith(Number) };

function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Folder name is required.');
  return value.trim().slice(0, 200);
}

export function folderId(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(value)) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Invalid folder ID.');
  return value;
}

export async function listFolders(principal: ApiPrincipal, query: URLSearchParams) {
  const limit = Number(query.get('limit') ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiRequestError(400, 'REQUEST_INVALID', 'limit must be between 1 and 200.');
  let after: { position: number; createdAt: number; id: string } | null = null;
  if (query.has('cursor')) {
    try {
      const cursor = query.get('cursor')!;
      if (cursor.length > 512) throw new Error();
      after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!after || !Number.isFinite(after.position) || !Number.isFinite(after.createdAt)) throw new Error();
      folderId(after.id);
    } catch { throw new ApiRequestError(400, 'REQUEST_INVALID', 'Invalid folder cursor.'); }
  }
  const rows = await db.select(fields).from(userFolders).where(and(eq(userFolders.userId, principal.userId),
    ...(after ? [or(gt(userFolders.position, after.position),
      and(eq(userFolders.position, after.position), gt(createdAt, after.createdAt)),
      and(eq(userFolders.position, after.position), eq(createdAt, after.createdAt), gt(userFolders.id, after.id)))] : []),
  )).orderBy(asc(userFolders.position), asc(createdAt), asc(userFolders.id)).limit(limit + 1) as FolderResource[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { data: page, nextCursor: rows.length > limit && last
    ? Buffer.from(JSON.stringify({ position: last.position, createdAt: last.createdAt, id: last.id })).toString('base64url') : null };
}

export async function requireFolder(principal: ApiPrincipal, id: string): Promise<FolderResource> {
  const rows = await db.select(fields).from(userFolders)
    .where(and(eq(userFolders.userId, principal.userId), eq(userFolders.id, folderId(id)))).limit(1) as FolderResource[];
  if (!rows[0]) throw new ApiRequestError(404, 'FOLDER_NOT_FOUND', 'Folder not found.');
  return rows[0];
}

export async function createFolder(principal: ApiPrincipal, body: Record<string, unknown>): Promise<FolderResource> {
  const folderName = name(body.name);
  const id = body.id === undefined ? randomUUID() : typeof body.id === 'string' ? folderId(body.id) : '';
  if (!id) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Invalid folder ID.');
  if (body.documentIds !== undefined && (!Array.isArray(body.documentIds) || body.documentIds.length > 200
    || !body.documentIds.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)))) {
    throw new ApiRequestError(400, 'REQUEST_INVALID', 'documentIds must contain at most 200 document IDs.');
  }
  const ids = [...new Set((body.documentIds ?? []) as string[])];
  const now = nowTimestampMs();
  const folder = { id, name: folderName, position: now, createdAt: now, updatedAt: now };
  await runInDbTransaction(async tx => {
    const existing = await tx.select({ id: userFolders.id }).from(userFolders).where(and(eq(userFolders.userId, principal.userId), eq(userFolders.id, id))).limit(1);
    if (existing.length) throw new ApiRequestError(409, 'FOLDER_EXISTS', 'A folder with this ID already exists.');
    if (ids.length) {
      const owned = await tx.select({ id: documents.id }).from(documents).where(and(eq(documents.userId, principal.userId), inArray(documents.id, ids)));
      if (owned.length !== ids.length) throw new ApiRequestError(404, 'DOCUMENT_NOT_FOUND', 'One or more documents were not found.');
    }
    await tx.insert(userFolders).values({ ...folder, userId: principal.userId });
    if (ids.length) await tx.update(documents).set({ folderId: id }).where(and(eq(documents.userId, principal.userId), inArray(documents.id, ids)));
  });
  return folder;
}

export async function updateFolder(principal: ApiPrincipal, id: string, body: Record<string, unknown>): Promise<FolderResource> {
  folderId(id);
  const patch: { name?: string; position?: number } = {};
  if ('name' in body) patch.name = name(body.name);
  if ('position' in body) {
    if (typeof body.position !== 'number' || !Number.isSafeInteger(body.position)) throw new ApiRequestError(400, 'REQUEST_INVALID', 'position must be a safe integer.');
    patch.position = body.position;
  }
  if (!Object.keys(patch).length) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Provide name or position.');
  const rows = await db.update(userFolders).set({ ...patch, updatedAt: nowTimestampMs() })
    .where(and(eq(userFolders.id, id), eq(userFolders.userId, principal.userId))).returning(fields) as FolderResource[];
  if (!rows[0]) throw new ApiRequestError(404, 'FOLDER_NOT_FOUND', 'Folder not found.');
  return rows[0];
}

/** Folder removal unfiles documents; it never deletes them. */
export async function deleteFolder(principal: ApiPrincipal, id?: string) {
  if (id !== undefined) folderId(id);
  await runInDbTransaction(async tx => {
    await tx.update(documents).set({ folderId: null }).where(and(eq(documents.userId, principal.userId), ...(id === undefined ? [] : [eq(documents.folderId, id)])));
    await tx.delete(userFolders).where(and(eq(userFolders.userId, principal.userId), ...(id === undefined ? [] : [eq(userFolders.id, id)])));
  });
}

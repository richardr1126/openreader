import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documents, userDocumentProgress } from '@openreader/database/schema';
import type { ApiPrincipal } from '@/lib/server/api/principal';
import { ApiRequestError } from '@/lib/server/api/responses';
import { isComputeWorkerUnavailableError } from '@/lib/server/compute-worker/client';
import { resolveCurrentPdfParse } from '@/lib/server/pdf-parse/operation';
import { isCurrentPdfParseOperationAuthoritative } from '@/lib/server/pdf-parse/snapshot';
import type { BaseDocument } from '@/types/documents';
import type { DocumentResource } from '@/types/document-api';
import { toBaseDocument, type StoredDocumentRow } from './document-row';
import { isValidDocumentId } from './blobstore';
import { deleteOwnedDocument } from './delete-owned';
import { verifyUploadFolder } from './finalize-upload';
import { safeDocumentName } from './utils';
import type { DocumentCaller } from './request';

export function documentId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!isValidDocumentId(id)) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Invalid document ID.');
  return id;
}

export async function listDocumentResources(principal: ApiPrincipal, query: URLSearchParams) {
  const limit = Number(query.get('limit') ?? 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ApiRequestError(400, 'REQUEST_INVALID', 'limit must be between 1 and 200.');
  const cursor = query.get('cursor') ? documentId(query.get('cursor')!) : null;
  const ids = query.has('ids') ? query.get('ids')!.split(',').map(documentId) : null;
  if (ids && ids.length > 200) throw new ApiRequestError(400, 'REQUEST_INVALID', 'At most 200 document IDs are allowed.');
  const q = query.get('q')?.trim() ?? '';
  if (q.length > 512) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Search is too long.');
  const conditions = [eq(documents.userId, principal.userId),
    ...(ids ? [inArray(documents.id, ids)] : []),
    ...(cursor ? [gt(documents.id, cursor)] : []),
    ...(q ? [sql`lower(${documents.name}) like ${`%${q.toLowerCase().replace(/[!%_]/g, '!$&')}%`} escape '!'`] : []),
    ...(query.has('folderId') ? [query.get('folderId') ? eq(documents.folderId, query.get('folderId')!) : isNull(documents.folderId)] : []),
  ];
  const rows = await db.select({
    id: documents.id, name: documents.name, type: documents.type, size: documents.size,
    lastModified: documents.lastModified, folderId: documents.folderId, recentlyOpenedAt: documents.recentlyOpenedAt,
    author: documents.author, language: documents.language,
    progress: userDocumentProgress.progress, progressUpdatedAt: userDocumentProgress.updatedAt,
    hasProgress: userDocumentProgress.documentId,
  }).from(documents).leftJoin(userDocumentProgress, and(eq(userDocumentProgress.userId, documents.userId), eq(userDocumentProgress.documentId, documents.id)))
    .where(and(...conditions)).orderBy(documents.id).limit(limit + 1) as Array<StoredDocumentRow & { progress: number | null; progressUpdatedAt: number | null; hasProgress: string | null }>;
  const page = rows.slice(0, limit);
  return { data: page.map(row => toBaseDocument(row, row.hasProgress ? { progress: row.progress, updatedAt: row.progressUpdatedAt } : null)),
    nextCursor: rows.length > limit ? page.at(-1)!.id : null };
}

export async function requireDocument(principal: ApiPrincipal, id: string): Promise<BaseDocument> {
  const rows = await db.select().from(documents).where(and(eq(documents.userId, principal.userId), eq(documents.id, documentId(id)))).limit(1) as StoredDocumentRow[];
  if (!rows[0]) throw new ApiRequestError(404, 'DOCUMENT_NOT_FOUND', 'Document not found.');
  return toBaseDocument(rows[0]);
}

export function documentWebUrl(document: Pick<BaseDocument, 'id' | 'type'>): string {
  const reader = document.type === 'epub' ? 'epub' : document.type === 'pdf' ? 'pdf' : 'html';
  return new URL(`/${reader}/${document.id}`, process.env.BASE_URL || 'http://localhost').toString();
}

/** A status read never opens the reader, updates recency or creates a plan. */
export async function describeDocument(document: BaseDocument): Promise<DocumentResource> {
  let status: DocumentResource['status'] = 'ready';
  let operationId: string | null = null;
  let error: string | null = null;
  if (document.type === 'pdf') {
    // A worker outage must not fail reads or commits that never needed the parse.
    const resolved = await resolveCurrentPdfParse({ documentId: document.id, namespace: null }).catch((cause: unknown) => {
      if (isComputeWorkerUnavailableError(cause)) return null;
      throw cause;
    });
    if (!resolved) status = 'unknown';
    else if (isCurrentPdfParseOperationAuthoritative(resolved) && resolved.operation) {
      operationId = resolved.operation.opId;
      status = resolved.operation.status === 'failed' ? 'failed' : resolved.operation.status === 'succeeded' && resolved.artifact ? 'ready' : 'processing';
      error = status === 'failed' ? resolved.operation.error?.message ?? 'PDF preparation failed.' : null;
    } else if (!resolved.artifact) status = resolved.operation ? 'processing' : 'not_started';
  }
  return { ...document, status, operationId, error, fileUrl: `/api/v1/documents/${document.id}/file`, webUrl: documentWebUrl(document) };
}

export async function updateDocuments(caller: DocumentCaller, ids: string[], patch: Record<string, unknown>) {
  if (!ids.length || ids.length > 200) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Provide between 1 and 200 document IDs.');
  ids = [...new Set(ids.map(documentId))];
  const owned = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.userId, caller.principal.userId), inArray(documents.id, ids)));
  if (owned.length !== ids.length) throw new ApiRequestError(404, 'DOCUMENT_NOT_FOUND', 'One or more documents were not found.');
  const updates: { name?: string; folderId?: string | null } = {};
  if ('name' in patch) {
    if (ids.length !== 1 || typeof patch.name !== 'string' || !patch.name.trim()) throw new ApiRequestError(400, 'REQUEST_INVALID', 'name must be a non-empty string for one document.');
    updates.name = safeDocumentName(patch.name.trim(), 'document.txt');
  }
  if ('folderId' in patch) {
    if (patch.folderId !== null && (typeof patch.folderId !== 'string' || !patch.folderId.trim())) throw new ApiRequestError(400, 'REQUEST_INVALID', 'folderId must be a non-empty string or null.');
    updates.folderId = patch.folderId === null ? null : (patch.folderId as string).trim();
    await verifyUploadFolder(updates.folderId, caller.principal.userId);
  }
  if (!Object.keys(updates).length) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Provide name or folderId.');
  await db.update(documents).set(updates).where(and(eq(documents.userId, caller.principal.userId), inArray(documents.id, ids)));
  return { data: await Promise.all(ids.map(id => requireDocument(caller.principal, id))) };
}

export async function removeDocuments(caller: DocumentCaller, ids: string[]) {
  if (!ids.length || ids.length > 200) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Provide between 1 and 200 document IDs.');
  const owned = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.userId, caller.principal.userId), inArray(documents.id, [...new Set(ids.map(documentId))])));
  let deleted = 0;
  for (const row of owned) if (await deleteOwnedDocument({ userId: caller.principal.userId, documentId: row.id, namespace: null, scheduleCleanup: caller.schedule })) deleted++;
  return { deleted };
}

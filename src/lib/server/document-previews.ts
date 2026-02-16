import { randomUUID } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { documentPreviews } from '@/db/schema';
import {
  DOCUMENT_PREVIEW_CONTENT_TYPE,
  DOCUMENT_PREVIEW_VARIANT,
  DOCUMENT_PREVIEW_WIDTH,
  deleteDocumentPreviewArtifacts,
  documentPreviewKey,
  headDocumentPreview,
  isMissingBlobError,
  putDocumentPreviewBuffer,
} from '@/lib/server/document-previews-blobstore';
import { getDocumentBlob } from '@/lib/server/documents-blobstore';
import { renderEpubCoverToJpeg, renderPdfFirstPageToJpeg } from '@/lib/server/document-previews-render';

const LEASE_MS = 45_000;
const RETRY_AFTER_MS = 1_500;
const FAILED_RETRY_AFTER_MS = 15_000;

type PreviewStatus = 'queued' | 'processing' | 'ready' | 'failed';

type PreviewRow = {
  documentId: string;
  namespace: string;
  variant: string;
  status: PreviewStatus;
  sourceLastModifiedMs: number;
  objectKey: string;
  contentType: string;
  width: number;
  height: number | null;
  byteSize: number | null;
  eTag: string | null;
  leaseOwner: string | null;
  leaseUntilMs: number;
  attemptCount: number;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type PreviewableDocumentType = 'pdf' | 'epub';

export type PreviewSourceDocument = {
  id: string;
  type: string;
  lastModified: number;
};

export type EnsureDocumentPreviewResult =
  | {
      state: 'ready';
      status: 'ready';
      contentType: string;
      width: number;
      height: number | null;
      byteSize: number | null;
      eTag: string | null;
    }
  | {
      state: 'pending';
      status: Exclude<PreviewStatus, 'ready'>;
      retryAfterMs: number;
      lastError: string | null;
    };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db as any;
}

function nowMs(): number {
  return Date.now();
}

function rowsAffected(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const rec = result as Record<string, unknown>;
  if (typeof rec.rowCount === 'number') return rec.rowCount;
  if (typeof rec.changes === 'number') return rec.changes;
  return 0;
}

function toNamespaceKey(namespace: string | null): string {
  return namespace?.trim() || '';
}

function previewObjectKey(documentId: string, namespace: string | null): string {
  return documentPreviewKey(documentId, namespace);
}

function asPreviewStatus(status: string | null | undefined): PreviewStatus {
  if (status === 'processing' || status === 'ready' || status === 'failed') return status;
  return 'queued';
}

function toPreviewRow(raw: Record<string, unknown>): PreviewRow {
  return {
    documentId: String(raw.documentId ?? ''),
    namespace: String(raw.namespace ?? ''),
    variant: String(raw.variant ?? ''),
    status: asPreviewStatus(String(raw.status ?? 'queued')),
    sourceLastModifiedMs: Number(raw.sourceLastModifiedMs ?? 0),
    objectKey: String(raw.objectKey ?? ''),
    contentType: String(raw.contentType ?? DOCUMENT_PREVIEW_CONTENT_TYPE),
    width: Number(raw.width ?? DOCUMENT_PREVIEW_WIDTH),
    height: raw.height == null ? null : Number(raw.height),
    byteSize: raw.byteSize == null ? null : Number(raw.byteSize),
    eTag: raw.eTag == null ? null : String(raw.eTag),
    leaseOwner: raw.leaseOwner == null ? null : String(raw.leaseOwner),
    leaseUntilMs: Number(raw.leaseUntilMs ?? 0),
    attemptCount: Number(raw.attemptCount ?? 0),
    lastError: raw.lastError == null ? null : String(raw.lastError),
    createdAtMs: Number(raw.createdAtMs ?? 0),
    updatedAtMs: Number(raw.updatedAtMs ?? 0),
  };
}

export function isPreviewableDocumentType(type: string): type is PreviewableDocumentType {
  return type === 'pdf' || type === 'epub';
}

async function getPreviewRow(documentId: string, namespaceKey: string): Promise<PreviewRow | null> {
  const rows = (await safeDb()
    .select()
    .from(documentPreviews)
    .where(
      and(
        eq(documentPreviews.documentId, documentId),
        eq(documentPreviews.namespace, namespaceKey),
        eq(documentPreviews.variant, DOCUMENT_PREVIEW_VARIANT),
      ),
    )) as Array<Record<string, unknown>>;
  const row = rows[0];
  return row ? toPreviewRow(row) : null;
}

async function ensurePreviewRowExists(doc: PreviewSourceDocument, namespaceKey: string, namespace: string | null): Promise<void> {
  const now = nowMs();
  await safeDb()
    .insert(documentPreviews)
    .values({
      documentId: doc.id,
      namespace: namespaceKey,
      variant: DOCUMENT_PREVIEW_VARIANT,
      status: 'queued',
      sourceLastModifiedMs: doc.lastModified,
      objectKey: previewObjectKey(doc.id, namespace),
      contentType: DOCUMENT_PREVIEW_CONTENT_TYPE,
      width: DOCUMENT_PREVIEW_WIDTH,
      leaseUntilMs: 0,
      attemptCount: 0,
      createdAtMs: now,
      updatedAtMs: now,
    })
    .onConflictDoNothing();
}

async function markPreviewRowQueued(
  doc: PreviewSourceDocument,
  namespaceKey: string,
  namespace: string | null,
): Promise<void> {
  const now = nowMs();
  await safeDb()
    .update(documentPreviews)
    .set({
      status: 'queued',
      sourceLastModifiedMs: doc.lastModified,
      objectKey: previewObjectKey(doc.id, namespace),
      contentType: DOCUMENT_PREVIEW_CONTENT_TYPE,
      width: DOCUMENT_PREVIEW_WIDTH,
      height: null,
      byteSize: null,
      eTag: null,
      leaseOwner: null,
      leaseUntilMs: 0,
      lastError: null,
      updatedAtMs: now,
    })
    .where(
      and(
        eq(documentPreviews.documentId, doc.id),
        eq(documentPreviews.namespace, namespaceKey),
        eq(documentPreviews.variant, DOCUMENT_PREVIEW_VARIANT),
      ),
    );
}

function needsRequeue(row: PreviewRow, doc: PreviewSourceDocument, namespace: string | null): boolean {
  if (row.sourceLastModifiedMs !== doc.lastModified) return true;
  if (row.objectKey !== previewObjectKey(doc.id, namespace)) return true;
  return false;
}

async function isReadyBlobMissing(docId: string, namespace: string | null): Promise<boolean> {
  try {
    await headDocumentPreview(docId, namespace);
    return false;
  } catch (error) {
    if (isMissingBlobError(error)) return true;
    throw error;
  }
}

async function tryClaimPreviewLease(docId: string, namespaceKey: string, owner: string): Promise<boolean> {
  const now = nowMs();
  const result = await safeDb()
    .update(documentPreviews)
    .set({
      status: 'processing',
      leaseOwner: owner,
      leaseUntilMs: now + LEASE_MS,
      attemptCount: sql`${documentPreviews.attemptCount} + 1`,
      lastError: null,
      updatedAtMs: now,
    })
    .where(
      and(
        eq(documentPreviews.documentId, docId),
        eq(documentPreviews.namespace, namespaceKey),
        eq(documentPreviews.variant, DOCUMENT_PREVIEW_VARIANT),
        or(
          inArray(documentPreviews.status, ['queued', 'failed']),
          and(
            eq(documentPreviews.status, 'processing'),
            lt(documentPreviews.leaseUntilMs, now),
          ),
        ),
      ),
    );
  return rowsAffected(result) > 0;
}

async function markPreviewReady(
  doc: PreviewSourceDocument,
  namespaceKey: string,
  content: { width: number; height: number | null; byteSize: number; eTag: string | null },
): Promise<void> {
  const now = nowMs();
  await safeDb()
    .update(documentPreviews)
    .set({
      status: 'ready',
      sourceLastModifiedMs: doc.lastModified,
      contentType: DOCUMENT_PREVIEW_CONTENT_TYPE,
      width: content.width,
      height: content.height,
      byteSize: content.byteSize,
      eTag: content.eTag,
      leaseOwner: null,
      leaseUntilMs: 0,
      lastError: null,
      updatedAtMs: now,
    })
    .where(
      and(
        eq(documentPreviews.documentId, doc.id),
        eq(documentPreviews.namespace, namespaceKey),
        eq(documentPreviews.variant, DOCUMENT_PREVIEW_VARIANT),
      ),
    );
}

async function markPreviewFailed(docId: string, namespaceKey: string, error: unknown): Promise<void> {
  const now = nowMs();
  const message = error instanceof Error ? error.message : String(error ?? 'Preview generation failed');
  await safeDb()
    .update(documentPreviews)
    .set({
      status: 'failed',
      leaseOwner: null,
      leaseUntilMs: 0,
      lastError: message.slice(0, 1000),
      updatedAtMs: now,
    })
    .where(
      and(
        eq(documentPreviews.documentId, docId),
        eq(documentPreviews.namespace, namespaceKey),
        eq(documentPreviews.variant, DOCUMENT_PREVIEW_VARIANT),
      ),
    );
}

async function generateAndStorePreview(doc: PreviewSourceDocument, namespace: string | null): Promise<void> {
  let workDir: string | null = null;
  try {
    const sourceBytes = await getDocumentBlob(doc.id, namespace);
    workDir = await mkdtemp(join(tmpdir(), 'openreader-preview-'));
    const sourcePath = join(workDir, 'source');
    await writeFile(sourcePath, sourceBytes);

    let rendered;
    if (doc.type === 'pdf') {
      rendered = await renderPdfFirstPageToJpeg(sourceBytes, DOCUMENT_PREVIEW_WIDTH);
    } else if (doc.type === 'epub') {
      rendered = await renderEpubCoverToJpeg(sourceBytes, DOCUMENT_PREVIEW_WIDTH);
    } else {
      throw new Error(`Unsupported preview type: ${doc.type}`);
    }

    await putDocumentPreviewBuffer(doc.id, rendered.bytes, namespace);
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function pendingResult(status: PreviewStatus, lastError: string | null): EnsureDocumentPreviewResult {
  return {
    state: 'pending',
    status: status === 'ready' ? 'processing' : status,
    retryAfterMs: status === 'failed' ? FAILED_RETRY_AFTER_MS : RETRY_AFTER_MS,
    lastError,
  };
}

export async function enqueueDocumentPreview(doc: PreviewSourceDocument, namespace: string | null): Promise<void> {
  if (!isPreviewableDocumentType(doc.type)) return;
  const namespaceKey = toNamespaceKey(namespace);
  await ensurePreviewRowExists(doc, namespaceKey, namespace);
  const row = await getPreviewRow(doc.id, namespaceKey);
  if (!row || needsRequeue(row, doc, namespace) || row.status === 'failed') {
    await markPreviewRowQueued(doc, namespaceKey, namespace);
  }
}

export async function ensureDocumentPreview(doc: PreviewSourceDocument, namespace: string | null): Promise<EnsureDocumentPreviewResult> {
  if (!isPreviewableDocumentType(doc.type)) {
    return pendingResult('failed', `Unsupported preview type: ${doc.type}`);
  }

  const namespaceKey = toNamespaceKey(namespace);
  await ensurePreviewRowExists(doc, namespaceKey, namespace);

  let row = await getPreviewRow(doc.id, namespaceKey);
  if (!row) {
    return pendingResult('queued', null);
  }

  if (needsRequeue(row, doc, namespace)) {
    await markPreviewRowQueued(doc, namespaceKey, namespace);
    row = await getPreviewRow(doc.id, namespaceKey);
    if (!row) return pendingResult('queued', null);
  }

  if (row.status === 'ready') {
    const missing = await isReadyBlobMissing(doc.id, namespace);
    if (!missing) {
      return {
        state: 'ready',
        status: 'ready',
        contentType: row.contentType || DOCUMENT_PREVIEW_CONTENT_TYPE,
        width: row.width || DOCUMENT_PREVIEW_WIDTH,
        height: row.height,
        byteSize: row.byteSize,
        eTag: row.eTag,
      };
    }
    await markPreviewRowQueued(doc, namespaceKey, namespace);
    row = await getPreviewRow(doc.id, namespaceKey);
    if (!row) return pendingResult('queued', null);
  }

  const now = nowMs();
  if (row.status === 'processing' && row.leaseUntilMs > now) {
    return pendingResult('processing', row.lastError);
  }

  const owner = `req-${randomUUID()}`;
  const claimed = await tryClaimPreviewLease(doc.id, namespaceKey, owner);
  if (claimed) {
    try {
      await generateAndStorePreview(doc, namespace);
      const head = await headDocumentPreview(doc.id, namespace);
      await markPreviewReady(doc, namespaceKey, {
        width: DOCUMENT_PREVIEW_WIDTH,
        height: null,
        byteSize: head.contentLength,
        eTag: head.eTag,
      });
    } catch (error) {
      console.error(`[document-previews] Preview generation failed for ${doc.id} (type=${doc.type}):`, error);
      await markPreviewFailed(doc.id, namespaceKey, error);
    }
  }

  row = await getPreviewRow(doc.id, namespaceKey);
  if (!row) return pendingResult('queued', null);

  if (row.status === 'ready') {
    const missing = await isReadyBlobMissing(doc.id, namespace);
    if (!missing) {
      return {
        state: 'ready',
        status: 'ready',
        contentType: row.contentType || DOCUMENT_PREVIEW_CONTENT_TYPE,
        width: row.width || DOCUMENT_PREVIEW_WIDTH,
        height: row.height,
        byteSize: row.byteSize,
        eTag: row.eTag,
      };
    }
    await markPreviewRowQueued(doc, namespaceKey, namespace);
    return pendingResult('queued', null);
  }

  return pendingResult(row.status, row.lastError);
}

export async function deleteDocumentPreviewRows(documentId: string, namespace: string | null): Promise<void> {
  const namespaceKey = toNamespaceKey(namespace);
  await safeDb()
    .delete(documentPreviews)
    .where(and(eq(documentPreviews.documentId, documentId), eq(documentPreviews.namespace, namespaceKey)));
}

export async function cleanupDocumentPreviewArtifacts(documentId: string, namespace: string | null): Promise<void> {
  await deleteDocumentPreviewArtifacts(documentId, namespace);
}

import { and, eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { documentPreviews } from '@openreader/database/schema';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import type { ComputeOperation } from '@/lib/server/compute-worker/protocol';
import { documentKey } from '@/lib/server/documents/blobstore';
import {
  DOCUMENT_PREVIEW_CONTENT_TYPE,
  DOCUMENT_PREVIEW_VARIANT,
  DOCUMENT_PREVIEW_WIDTH,
  documentPreviewKey,
  headDocumentPreview,
  isMissingBlobError,
} from '@/lib/server/documents/previews-blobstore';

type PreviewStatus = 'queued' | 'processing' | 'ready' | 'failed';

type PreviewRow = {
  status: PreviewStatus;
  sourceLastModifiedMs: number;
  objectKey: string;
  contentType: string;
  width: number;
  height: number | null;
  byteSize: number | null;
  eTag: string | null;
  lastError: string | null;
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
      opId: string | null;
      lastError: string | null;
    };

type DocumentPreviewArtifact = {
  objectKey: string;
  contentType: string;
  width: number;
  height: number | null;
  byteLength: number;
  eTag: string | null;
  sourceLastModifiedMs: number;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeDb(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db as any;
}

function nowMs(): number {
  return Date.now();
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
    status: asPreviewStatus(String(raw.status ?? 'queued')),
    sourceLastModifiedMs: Number(raw.sourceLastModifiedMs ?? 0),
    objectKey: String(raw.objectKey ?? ''),
    contentType: String(raw.contentType ?? DOCUMENT_PREVIEW_CONTENT_TYPE),
    width: Number(raw.width ?? DOCUMENT_PREVIEW_WIDTH),
    height: raw.height == null ? null : Number(raw.height),
    byteSize: raw.byteSize == null ? null : Number(raw.byteSize),
    eTag: raw.eTag == null ? null : String(raw.eTag),
    lastError: raw.lastError == null ? null : String(raw.lastError),
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

async function markPreviewPending(
  doc: PreviewSourceDocument,
  namespaceKey: string,
  namespace: string | null,
  status: 'queued' | 'processing',
): Promise<void> {
  const now = nowMs();
  await safeDb()
    .update(documentPreviews)
    .set({
      status,
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

async function markPreviewReady(
  doc: PreviewSourceDocument,
  namespaceKey: string,
  artifact: DocumentPreviewArtifact,
): Promise<void> {
  const now = nowMs();
  await safeDb()
    .update(documentPreviews)
    .set({
      status: 'ready',
      sourceLastModifiedMs: artifact.sourceLastModifiedMs,
      objectKey: artifact.objectKey,
      contentType: artifact.contentType || DOCUMENT_PREVIEW_CONTENT_TYPE,
      width: artifact.width || DOCUMENT_PREVIEW_WIDTH,
      height: artifact.height,
      byteSize: artifact.byteLength,
      eTag: artifact.eTag,
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

async function markPreviewFailed(
  doc: PreviewSourceDocument,
  namespaceKey: string,
  message: string,
): Promise<void> {
  const now = nowMs();
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
        eq(documentPreviews.documentId, doc.id),
        eq(documentPreviews.namespace, namespaceKey),
        eq(documentPreviews.variant, DOCUMENT_PREVIEW_VARIANT),
      ),
    );
}

function needsRefresh(row: PreviewRow, doc: PreviewSourceDocument, namespace: string | null): boolean {
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

function pendingResult(status: PreviewStatus, lastError: string | null, opId: string | null = null): EnsureDocumentPreviewResult {
  return {
    state: 'pending',
    status: status === 'ready' ? 'processing' : status,
    opId,
    lastError,
  };
}

function statusFromOperation(operation: ComputeOperation | null | undefined): 'queued' | 'processing' | 'failed' | null {
  if (!operation) return null;
  if (operation.status === 'queued') return 'queued';
  if (operation.status === 'running') return 'processing';
  if (operation.status === 'failed') return 'failed';
  if (operation.status === 'succeeded') return 'processing';
  return null;
}

async function resolveWorkerPreview(
  doc: PreviewSourceDocument & { type: PreviewableDocumentType },
  namespace: string | null,
) {
  const client = getComputeWorkerClient();
  const base = {
    documentId: doc.id,
    namespace,
    documentType: doc.type,
    sourceObjectKey: documentKey(doc.id, namespace),
    sourceLastModifiedMs: Number(doc.lastModified),
    previewKind: 'card' as const,
  };
  const resolved = await client.resolveDocumentPreview(base);
  if (resolved.artifact) return resolved;
  if (resolved.operation && (resolved.operation.status === 'queued' || resolved.operation.status === 'running')) return resolved;
  const operation = await client.createDocumentPreviewOperation({
    ...base,
    targetWidth: DOCUMENT_PREVIEW_WIDTH,
  });
  return {
    artifact: null,
    operation,
  };
}

export async function enqueueDocumentPreview(doc: PreviewSourceDocument, namespace: string | null): Promise<void> {
  if (!isPreviewableDocumentType(doc.type)) return;
  const namespaceKey = toNamespaceKey(namespace);
  await ensurePreviewRowExists(doc, namespaceKey, namespace);
  if (!isComputeWorkerAvailable()) {
    await markPreviewFailed(doc, namespaceKey, 'Compute worker is required for document preview generation');
    return;
  }
  const resolved = await resolveWorkerPreview({ ...doc, type: doc.type }, namespace);
  const status = statusFromOperation(resolved.operation);
  if (resolved.artifact) {
    await markPreviewReady(doc, namespaceKey, resolved.artifact);
  } else if (status === 'failed') {
    await markPreviewFailed(doc, namespaceKey, resolved.operation?.error?.message ?? 'Document preview generation failed');
  } else {
    await markPreviewPending(doc, namespaceKey, namespace, status ?? 'queued');
  }
}

export async function ensureDocumentPreview(doc: PreviewSourceDocument, namespace: string | null): Promise<EnsureDocumentPreviewResult> {
  if (!isPreviewableDocumentType(doc.type)) {
    return pendingResult('failed', `Unsupported preview type: ${doc.type}`);
  }

  const namespaceKey = toNamespaceKey(namespace);
  await ensurePreviewRowExists(doc, namespaceKey, namespace);

  let row = await getPreviewRow(doc.id, namespaceKey);
  if (row?.status === 'ready' && !needsRefresh(row, doc, namespace) && !await isReadyBlobMissing(doc.id, namespace)) {
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

  if (!isComputeWorkerAvailable()) {
    await markPreviewFailed(doc, namespaceKey, 'Compute worker is required for document preview generation');
    return pendingResult('failed', 'Compute worker is required for document preview generation');
  }

  const resolved = await resolveWorkerPreview({ ...doc, type: doc.type }, namespace);
  if (resolved.artifact) {
    await markPreviewReady(doc, namespaceKey, resolved.artifact);
    row = await getPreviewRow(doc.id, namespaceKey);
    return {
      state: 'ready',
      status: 'ready',
      contentType: row?.contentType || DOCUMENT_PREVIEW_CONTENT_TYPE,
      width: row?.width || DOCUMENT_PREVIEW_WIDTH,
      height: row?.height ?? resolved.artifact.height,
      byteSize: row?.byteSize ?? resolved.artifact.byteLength,
      eTag: row?.eTag ?? resolved.artifact.eTag,
    };
  }

  const operationStatus = statusFromOperation(resolved.operation);
  if (operationStatus === 'failed') {
    const message = resolved.operation?.error?.message ?? 'Document preview generation failed';
    await markPreviewFailed(doc, namespaceKey, message);
    return pendingResult('failed', message, resolved.operation?.opId ?? null);
  }

  await markPreviewPending(doc, namespaceKey, namespace, operationStatus ?? 'queued');
  return pendingResult(operationStatus ?? 'queued', null, resolved.operation?.opId ?? null);
}

export async function deleteDocumentPreviewRows(documentId: string, namespace: string | null): Promise<void> {
  const namespaceKey = toNamespaceKey(namespace);
  await safeDb()
    .delete(documentPreviews)
    .where(and(eq(documentPreviews.documentId, documentId), eq(documentPreviews.namespace, namespaceKey)));
}

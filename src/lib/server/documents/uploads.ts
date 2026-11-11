import { randomUUID } from 'node:crypto';
import { ApiRequestError } from '@/lib/server/api/responses';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { getBrowserStorageTransport } from '@/lib/server/storage/s3';
import type { DocumentUploadResource, PreparedDocumentUpload } from '@/types/document-api';
import { createAdmittedComputeOperation } from '@/lib/server/compute-limits/run-admitted';
import { ComputeAdmissionLimitedError } from '@/lib/server/compute-limits/run-admitted';
import { createOrReuseCurrentPdfParseOperation, resolveCurrentPdfParse } from '@/lib/server/pdf-parse/operation';
import { getComputeWorkerClient, isComputeWorkerAvailable, isComputeWorkerUnavailableError } from '@/lib/server/compute-worker/client';
import { TEMP_DOCUMENT_UPLOAD_TTL_MS, getTempDocumentFinalizeReceipt, putTempDocumentFinalizeReceipt,
  putTempDocumentBlob, presignTempPut, isValidTempUploadToken, headTempDocumentBlob, verifyDocumentBlobIntegrity } from './blobstore';
import { finalizeUploadedDocument, verifyUploadFolder, type FinalizeUpload } from './finalize-upload';
import { describeDocument, requireDocument } from './resources';
import { documentContentType, safeDocumentName, toDocumentTypeFromName } from './utils';
import { buildDocxConversionRequest, headTempUploadForConversion } from './docx-conversion-jobs';
import type { DocumentCaller } from './request';
import type { BaseDocument } from '@/types/documents';
import { normalizeAuthor, normalizeLanguage } from './import-metadata';
import { assertStorageAvailable } from '@/lib/server/storage/usage';
import { consumeDocumentIntake } from './intake';

type UploadReceipt = { upload: FinalizeUpload; createdAt: number; size: number; requested: boolean; received?: boolean } | { stored: BaseDocument };

export function uploadId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!isValidTempUploadToken(id)) throw new ApiRequestError(400, 'REQUEST_INVALID', 'Invalid upload ID.');
  return id;
}

async function receipt(caller: DocumentCaller, id: string): Promise<UploadReceipt> {
  const value = await getTempDocumentFinalizeReceipt<UploadReceipt>(uploadId(id), caller.principal.userId, null);
  if (!value) throw new ApiRequestError(404, 'UPLOAD_NOT_FOUND', 'Upload not found or expired.');
  if ('upload' in value && Date.now() - value.createdAt > TEMP_DOCUMENT_UPLOAD_TTL_MS) throw new ApiRequestError(410, 'UPLOAD_EXPIRED', 'Upload expired.');
  return value;
}

async function saveReceipt(caller: DocumentCaller, id: string, value: UploadReceipt) {
  await putTempDocumentFinalizeReceipt(id, caller.principal.userId, null, Buffer.from(JSON.stringify(value)));
}

export async function prepareDocumentUpload(caller: DocumentCaller, body: Record<string, unknown>): Promise<PreparedDocumentUpload> {
  return createPreparedUpload(caller, body, (id) => consumeDocumentIntake(caller.subject, id));
}

async function createPreparedUpload(caller: DocumentCaller, body: Record<string, unknown>, charge?: (id: string) => Promise<void>): Promise<PreparedDocumentUpload> {
  if (typeof body.name !== 'string' || !body.name.trim()) throw new ApiRequestError(400, 'REQUEST_INVALID', 'name is required.');
  const name = safeDocumentName(body.name.trim(), 'document.txt');
  if (!/\.(pdf|epub|docx|txt|md|markdown|mdown|mkd|html|htm)$/i.test(name)) throw new ApiRequestError(415, 'FILE_TYPE_UNSUPPORTED', 'Unsupported document type.');
  const size = body.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) throw new ApiRequestError(400, 'REQUEST_INVALID', 'size must be a positive integer.');
  const config = await getResolvedRuntimeConfig();
  const { maxUploadMb } = config;
  if (size > maxUploadMb * 1024 * 1024) throw new ApiRequestError(413, 'UPLOAD_TOO_LARGE', 'Upload exceeds the configured maximum size.');
  const contentType = documentContentType(name);
  const id = randomUUID();
  await assertStorageAvailable(caller.subject, size, config);
  await charge?.(id);
  const value: UploadReceipt = { createdAt: Date.now(), size, requested: false, upload: {
    token: id, name, type: toDocumentTypeFromName(name),
    lastModified: typeof body.lastModified === 'number' && Number.isSafeInteger(body.lastModified) && body.lastModified > 0 ? body.lastModified : Date.now(),
    folderId: undefined, hints: {
      author: normalizeAuthor(body.author),
      language: normalizeLanguage(body.language),
    },
  } };
  await saveReceipt(caller, id, value);
  const proxy = getBrowserStorageTransport() === 'proxy';
  const transfer = proxy
    ? { url: `/api/v1/uploads/${id}/file`, headers: { 'Content-Type': contentType } }
    : await presignTempPut(id, caller.principal.userId, contentType, null, { contentLength: size });
  return { id, ...transfer, expiresAt: value.createdAt + (proxy ? TEMP_DOCUMENT_UPLOAD_TTL_MS : 5 * 60 * 1000) };
}

/** With `once`, as for a signed upload link, the file can arrive only one time, so it can't be swapped before it is added. */
export async function receiveDocumentUpload(caller: DocumentCaller, id: string, body: ReadableStream<Uint8Array> | null, { once = false } = {}): Promise<void> {
  if (getBrowserStorageTransport() !== 'proxy') throw new ApiRequestError(409, 'PROXY_UPLOAD_DISABLED', 'Use the prepared storage URL for this upload.');
  const value = await receipt(caller, id);
  if (!('upload' in value) || value.requested) throw new ApiRequestError(409, 'UPLOAD_ALREADY_SUBMITTED', 'This upload has already been submitted.');
  if (once && value.received) throw new ApiRequestError(409, 'UPLOAD_ALREADY_RECEIVED', 'This upload link has already been used. Run "docs upload" again for a new one.');
  const reader = body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (reader) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > value.size) throw new ApiRequestError(413, 'UPLOAD_TOO_LARGE', 'Upload exceeds its declared size.');
      chunks.push(next.value);
    }
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
  if (size !== value.size) throw new ApiRequestError(400, 'UPLOAD_INCOMPLETE', 'Upload does not match its declared size.');
  await putTempDocumentBlob(id, caller.principal.userId, Buffer.concat(chunks), documentContentType(value.upload.name), null);
  if (once) await saveReceipt(caller, id, { ...value, received: true });
}

/**
 * The document is already registered, so a refused parse must not fail the
 * request. It reports as not_started, and the next upload status read tries again.
 */
async function readyDocument(caller: DocumentCaller, stored: BaseDocument) {
  if (stored.type === 'pdf' && isComputeWorkerAvailable()) {
    try {
      const current = await resolveCurrentPdfParse({ documentId: stored.id, namespace: null });
      if (!current.artifact && !current.operation) {
        const policy = (await getResolvedRuntimeConfig()).computeLimitPolicies;
        await createAdmittedComputeOperation({ policy, action: 'pdf_layout',
          requestKey: `${stored.id}:${stored.lastModified}:current`, subject: caller.subject,
          create: () => createOrReuseCurrentPdfParseOperation({ documentId: stored.id, namespace: null }),
        });
      }
    } catch (error) {
      if (!(error instanceof ComputeAdmissionLimitedError) && !isComputeWorkerUnavailableError(error)) throw error;
    }
  }
  return describeDocument(stored);
}

export async function readDocumentUpload(caller: DocumentCaller, id: string): Promise<DocumentUploadResource> {
  const value = await receipt(caller, id);
  const base = { id, document: null, operationId: null, error: null, statusUrl: `/api/v1/uploads/${id}`, eventsUrl: null };
  if ('stored' in value) {
    const document = await requireDocument(caller.principal, value.stored.id);
    const size = await verifyDocumentBlobIntegrity(document.id, null);
    return { ...base, status: 'ready', document: await readyDocument(caller, { ...document, size }) };
  }
  if (!value.requested) return { ...base, status: 'pending' };
  const result = await finalizeUploadedDocument({ upload: value.upload, expectedSize: value.size, userId: caller.principal.userId, namespace: null, subject: caller.subject, schedulePreview: caller.schedule });
  if (result.kind === 'stored') return { ...base, status: 'ready', document: await readyDocument(caller, result.stored) };
  const operation = result.kind === 'failed' ? result.failed : result.pending;
  return { ...base, status: result.kind === 'failed' ? 'failed' : 'processing', operationId: operation.opId,
    error: result.kind === 'failed' ? result.failed.error : null,
    eventsUrl: operation.opId ? `/api/v1/uploads/${id}/events?opId=${encodeURIComponent(operation.opId)}` : null };
}

/** A repeated submit is idempotent only when it asks for the same folder. */
function assertSameFolder(value: UploadReceipt, folder: string | null | undefined) {
  if (folder === undefined) return;
  const current = 'stored' in value ? value.stored.folderId ?? null : value.upload.folderId ?? null;
  if (current !== folder) throw new ApiRequestError(409, 'UPLOAD_ALREADY_SUBMITTED', 'This upload was already submitted to a different folder. Move the document instead.');
}

export async function submitDocumentUpload(caller: DocumentCaller, id: string, folderId?: unknown) {
  if (folderId !== undefined && folderId !== null && (typeof folderId !== 'string' || !folderId.trim())) throw new ApiRequestError(400, 'REQUEST_INVALID', 'folderId must be a string or null.');
  const folder = folderId === undefined ? undefined : folderId === null ? null : (folderId as string).trim();
  const value = await receipt(caller, id);
  if ('upload' in value && !value.requested) {
    value.upload.folderId = folder;
    await verifyUploadFolder(folder ?? null, caller.principal.userId);
    const head = await headTempDocumentBlob(id, caller.principal.userId, null);
    if (head.contentLength !== value.size) throw new ApiRequestError(400, 'UPLOAD_INCOMPLETE', 'Upload does not match its declared size.');
    value.requested = true;
    // A concurrent submit may have finished meanwhile; never write over its receipt.
    const latest = await receipt(caller, id);
    if ('upload' in latest && !latest.requested) await saveReceipt(caller, id, value);
    else assertSameFolder(latest, folder);
  } else {
    assertSameFolder(value, folder);
  }
  return readDocumentUpload(caller, id);
}

/** Server-side imports charge daily intake before they fetch, so this does not charge again. */
export async function stageDocumentUpload(caller: DocumentCaller, body: Buffer, metadata: Record<string, unknown>): Promise<string> {
  const prepared = await createPreparedUpload(caller, { ...metadata, size: body.byteLength });
  await putTempDocumentBlob(prepared.id, caller.principal.userId, body, documentContentType(String(metadata.name)), null);
  return prepared.id;
}

export async function authorizeUploadOperation(caller: DocumentCaller, id: string, operationId: string) {
  const value = await receipt(caller, id);
  if (!('upload' in value)) return false;
  const temp = await headTempUploadForConversion({ token: id, userId: caller.principal.userId, namespace: null });
  const expected = buildDocxConversionRequest({ upload: value.upload, temp, userId: caller.principal.userId, namespace: null });
  const operation = await getComputeWorkerClient().getOperation(operationId);
  return operation?.subject.kind === 'document_conversion' && operation.subject.conversionId === expected.conversionId && operation.subject.namespace === null;
}

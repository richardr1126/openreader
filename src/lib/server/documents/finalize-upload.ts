import path from 'path';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@openreader/database';
import { userFolders } from '@openreader/database/schema';
import {
  TEMP_DOCUMENT_UPLOAD_TTL_MS,
  copyObjectKeyToDocument,
  copyTempDocumentBlobToDocument,
  deleteTempDocumentUpload,
  getTempDocumentBlob,
  getTempDocumentFinalizeReceipt,
  headDocumentBlob,
  headTempDocumentBlob,
  isDocumentBlobIntegrityError,
  isMissingBlobError,
  isPreconditionFailed,
  putTempDocumentFinalizeReceipt,
  verifyDocumentBlobIntegrity,
} from '@/lib/server/documents/blobstore';
import {
  buildDocxConversionRequest,
  headTempUploadForConversion,
} from '@/lib/server/documents/docx-conversion-jobs';
import { registerUploadedDocument } from '@/lib/server/documents/register-upload';
import { extractImportMetadata, type ImportMetadata } from '@/lib/server/documents/import-metadata';
import { withDocumentBlobLease } from '@/lib/server/documents/blob-lease';
import { documentContentType, safeDocumentName } from '@/lib/server/documents/utils';
import { ApiRequestError } from '@/lib/server/api/responses';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import type {
  ComputeOperation,
  DocumentConversionArtifactMetadata,
} from '@/lib/server/compute-worker/protocol';
import { errorToLog, serverLogger } from '@/lib/server/logger';
import type { ComputeLimitSubject } from '@/lib/server/compute-limits/policy';
import type { BaseDocument, DocumentType } from '@/types/documents';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { createAdmittedComputeOperation } from '@/lib/server/compute-limits/run-admitted';

export type FinalizeUpload = {
  token: string;
  name: string;
  type: DocumentType;
  lastModified: number;
  folderId: string | null | undefined;
  /** Client-supplied import hints (catalog entry, article byline); validated in extractImportMetadata. */
  hints: Partial<ImportMetadata>;
};

export class UploadFolderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'UploadFolderError';
  }
}

type FinalizeReceipt = {
  stored: BaseDocument;
};

type PendingConversion = {
  token: string;
  name: string;
  conversionId: string;
  opId: string | null;
  status: 'queued' | 'running';
};

type FailedConversion = {
  token: string;
  name: string;
  conversionId: string;
  opId: string | null;
  status: 'failed';
  error: string;
};

export type FinalizeResult =
  | { kind: 'stored'; stored: BaseDocument }
  | { kind: 'pending'; pending: PendingConversion }
  | { kind: 'failed'; failed: FailedConversion };

export async function verifyUploadFolder(folderId: string | null, userId: string): Promise<void> {
  if (!folderId) return;
  const [folder] = await db.select({ id: userFolders.id }).from(userFolders).where(and(
    eq(userFolders.id, folderId),
    eq(userFolders.userId, userId),
  )).limit(1);
  if (!folder) throw new UploadFolderError('Folder not found', 404);
}

async function loadTempUpload(input: {
  token: string;
  userId: string;
  namespace: string | null;
}): Promise<{ contentType: string; size: number; lastModified: number; body: Buffer }> {
  const RETRIES = 3;
  const RETRY_DELAY_MS = 500;

  let lastError: unknown = null;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const head = await headTempDocumentBlob(input.token, input.userId, input.namespace);
      const body = await getTempDocumentBlob(input.token, input.userId, input.namespace);
      return {
        contentType: head.contentType ?? 'application/octet-stream',
        size: head.contentLength > 0 ? head.contentLength : body.byteLength,
        lastModified: head.lastModified ?? Date.now(),
        body,
      };
    } catch (error) {
      lastError = error;
      if (isMissingBlobError(error) && attempt < RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Temporary upload is unavailable');
}

/**
 * The canonical key is a SHA-256 address. HEAD alone does not prove its
 * contents are complete. Verify within the document lease before registering.
 * If the existing/copy-once object is corrupt, make one bounded replacement
 * from the known-good source and verify again; never record an unverified copy.
 */
async function ensureVerifiedDocumentBlob(input: {
  documentId: string;
  namespace: string | null;
  expectedSize: number;
  copy: (ifNoneMatch: boolean) => Promise<void>;
}): Promise<number> {
  try {
    await headDocumentBlob(input.documentId, input.namespace);
  } catch (error) {
    if (!isMissingBlobError(error)) throw error;
    try {
      await input.copy(true);
    } catch (copyError) {
      if (!isPreconditionFailed(copyError)) throw copyError;
    }
  }

  try {
    return await verifyDocumentBlobIntegrity(input.documentId, input.namespace, input.expectedSize);
  } catch (error) {
    if (!isDocumentBlobIntegrityError(error)) throw error;
  }

  // Only recover an integrity mismatch, not an S3 transport/auth failure.
  await input.copy(false);
  return verifyDocumentBlobIntegrity(input.documentId, input.namespace, input.expectedSize);
}

async function registerConvertedDocx(input: {
  upload: FinalizeUpload;
  userId: string;
  namespace: string | null;
  artifact: DocumentConversionArtifactMetadata;
  schedulePreview: (task: () => Promise<void>) => void;
}): Promise<BaseDocument> {
  const finalizedName = safeDocumentName(`${path.parse(input.upload.name).name}.pdf`, 'upload.pdf');
  const documentId = input.artifact.documentId;

  const stored = await withDocumentBlobLease(documentId, async () => {
    const canonicalSize = await ensureVerifiedDocumentBlob({
      documentId,
      namespace: input.namespace,
      expectedSize: input.artifact.byteLength,
      copy: (ifNoneMatch) => copyObjectKeyToDocument(
        input.artifact.objectKey,
        documentId,
        input.namespace,
        'application/pdf',
        ifNoneMatch ? { ifNoneMatch: true } : undefined,
      ),
    });
    return registerUploadedDocument({
      documentId,
      userId: input.userId,
      namespace: input.namespace,
      name: finalizedName,
      type: 'pdf',
      size: canonicalSize,
      lastModified: input.upload.lastModified,
      folderId: input.upload.folderId,
      ...extractImportMetadata({ type: 'pdf', name: finalizedName, body: null, hints: input.upload.hints }),
      schedulePreview: input.schedulePreview,
    });
  });

  await putTempDocumentFinalizeReceipt(
    input.upload.token,
    input.userId,
    input.namespace,
    Buffer.from(JSON.stringify({ stored }), 'utf8'),
  );

  await deleteTempDocumentUpload(input.upload.token, input.userId, input.namespace).catch((error) => {
    serverLogger.warn({
      event: 'documents.blob.upload.finalize.temp_delete_failed',
      degraded: true,
      fallbackPath: 'leave_temp_upload',
      documentId,
      token: input.upload.token,
      error: errorToLog(error),
    }, 'Failed to delete temp upload after DOCX conversion finalize');
  });

  return stored;
}

/** A presigned PUT stays usable after submit, so the bytes can change until finalize reads them. */
function assertDeclaredSize(actual: number, declared: number) {
  if (actual !== declared) throw new ApiRequestError(400, 'UPLOAD_INCOMPLETE', 'Upload does not match its declared size.');
}

async function finalizeDocx(input: FinalizeInput): Promise<FinalizeResult> {
  if (!isComputeWorkerAvailable()) {
    throw new ApiRequestError(503, 'COMPUTE_WORKER_REQUIRED', 'Compute worker is required for DOCX conversion.');
  }

  const temp = await headTempUploadForConversion({
    token: input.upload.token,
    userId: input.userId,
    namespace: input.namespace,
  });
  assertDeclaredSize(temp.size, input.expectedSize);

  if (Date.now() - temp.lastModified > TEMP_DOCUMENT_UPLOAD_TTL_MS) {
    await deleteTempDocumentUpload(input.upload.token, input.userId, input.namespace).catch(() => undefined);
    throw new Error('Temporary upload expired before finalize');
  }

  const conversionRequest = buildDocxConversionRequest({
    upload: input.upload,
    temp,
    userId: input.userId,
    namespace: input.namespace,
  });
  const client = getComputeWorkerClient();
  const resolved = await client.resolveDocumentConversion(conversionRequest);
  if (resolved.artifact) {
    return {
      kind: 'stored',
      stored: await registerConvertedDocx({
        upload: input.upload,
        userId: input.userId,
        namespace: input.namespace,
        artifact: resolved.artifact,
        schedulePreview: input.schedulePreview,
      }),
    };
  }

  const runtimeConfig = await getResolvedRuntimeConfig();
  const operation: ComputeOperation | null = resolved.operation
    ?? await createAdmittedComputeOperation({
      policy: runtimeConfig.computeLimitPolicies,
      action: 'document_conversion',
      requestKey: `${conversionRequest.conversionId}:${temp.lastModified}`,
      subject: input.subject,
      create: () => client.createDocumentConversionOperation(conversionRequest),
    });
  if (operation?.status === 'failed') {
    return {
      kind: 'failed',
      failed: {
        token: input.upload.token,
        name: input.upload.name,
        conversionId: conversionRequest.conversionId,
        opId: operation.opId ?? null,
        status: 'failed',
        error: operation.error?.message ?? 'DOCX conversion failed',
      },
    };
  }

  return {
    kind: 'pending',
    pending: {
      token: input.upload.token,
      name: input.upload.name,
      conversionId: conversionRequest.conversionId,
      opId: operation?.opId ?? resolved.operation?.opId ?? null,
      status: operation?.status === 'running' || resolved.operation?.status === 'running' ? 'running' : 'queued',
    },
  };
}

export async function finalizeUploadedDocument(input: FinalizeInput): Promise<FinalizeResult> {
  const existingReceipt = await getTempDocumentFinalizeReceipt<FinalizeReceipt>(
    input.upload.token,
    input.userId,
    input.namespace,
  );
  if (existingReceipt?.stored) {
    // A stale success receipt must not bypass validation of the canonical bytes.
    const verifiedSize = await verifyDocumentBlobIntegrity(
      existingReceipt.stored.id,
      input.namespace,
    );
    return { kind: 'stored', stored: { ...existingReceipt.stored, size: verifiedSize } };
  }

  const isDocxUpload = input.upload.type === 'docx';
  if (isDocxUpload) {
    return finalizeDocx(input);
  }

  const temp = await loadTempUpload({
    token: input.upload.token,
    userId: input.userId,
    namespace: input.namespace,
  });
  assertDeclaredSize(temp.size, input.expectedSize);

  if (Date.now() - temp.lastModified > TEMP_DOCUMENT_UPLOAD_TTL_MS) {
    await deleteTempDocumentUpload(input.upload.token, input.userId, input.namespace).catch(() => undefined);
    throw new Error('Temporary upload expired before finalize');
  }

  const finalizedType: DocumentType = input.upload.type;
  const finalizedBody = temp.body;
  const finalizedName = input.upload.name;
  const finalizedContentType = documentContentType(finalizedName);
  const documentId = createHash('sha256').update(finalizedBody).digest('hex');
  const metadata = extractImportMetadata({
    type: finalizedType,
    name: finalizedName,
    body: finalizedBody,
    hints: input.upload.hints,
  });

  const stored = await withDocumentBlobLease(documentId, async () => {
    // Keep verification and registration under the lease; other users may
    // reference the same content-addressed object.
    const canonicalSize = await ensureVerifiedDocumentBlob({
      documentId,
      namespace: input.namespace,
      expectedSize: finalizedBody.byteLength,
      copy: (ifNoneMatch) => copyTempDocumentBlobToDocument(
        input.upload.token,
        input.userId,
        documentId,
        input.namespace,
        finalizedContentType,
        ifNoneMatch ? { ifNoneMatch: true } : undefined,
      ),
    });
    return registerUploadedDocument({
      documentId,
      userId: input.userId,
      namespace: input.namespace,
      name: finalizedName,
      type: finalizedType,
      size: canonicalSize,
      lastModified: input.upload.lastModified,
      folderId: input.upload.folderId,
      ...metadata,
      schedulePreview: input.schedulePreview,
    });
  });

  await putTempDocumentFinalizeReceipt(
    input.upload.token,
    input.userId,
    input.namespace,
    Buffer.from(JSON.stringify({ stored }), 'utf8'),
  );

  await deleteTempDocumentUpload(input.upload.token, input.userId, input.namespace).catch((error) => {
    serverLogger.warn({
      event: 'documents.blob.upload.finalize.temp_delete_failed',
      degraded: true,
      fallbackPath: 'leave_temp_upload',
      documentId,
      token: input.upload.token,
      error: errorToLog(error),
    }, 'Failed to delete temp upload after finalize');
  });

  return { kind: 'stored', stored };
}


type FinalizeInput = {
  upload: FinalizeUpload;
  expectedSize: number;
  userId: string;
  namespace: string | null;
  subject: ComputeLimitSubject;
  schedulePreview: (task: () => Promise<void>) => void;
};


import { beforeEach, describe, expect, test, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  requireAuthContext: vi.fn(),
  registerUploadedDocument: vi.fn(),
  isComputeWorkerAvailable: vi.fn(),
  resolveDocumentConversion: vi.fn(),
  createDocumentConversionOperation: vi.fn(),
  headTempDocumentBlob: vi.fn(),
  getTempDocumentBlob: vi.fn(),
  getTempDocumentFinalizeReceipt: vi.fn(),
  putTempDocumentFinalizeReceipt: vi.fn(),
  deleteTempDocumentUpload: vi.fn(),
  headDocumentBlob: vi.fn(),
  copyTempDocumentBlobToDocument: vi.fn(),
  copyObjectKeyToDocument: vi.fn(),
  tempDocumentUploadKey: vi.fn(),
  verifyDocumentBlobIntegrity: vi.fn(),
  createAdmittedComputeOperation: vi.fn(),
}));

vi.mock('@/lib/server/auth/auth', () => ({
  requireAuthContext: hoisted.requireAuthContext,
}));

vi.mock('@/lib/server/documents/register-upload', () => ({
  registerUploadedDocument: hoisted.registerUploadedDocument,
}));

vi.mock('@/lib/server/documents/blob-lease', () => ({
  withDocumentBlobLease: vi.fn(async (_documentId: string, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: hoisted.isComputeWorkerAvailable,
  getComputeWorkerClient: vi.fn(() => ({
    resolveDocumentConversion: hoisted.resolveDocumentConversion,
    createDocumentConversionOperation: hoisted.createDocumentConversionOperation,
  })),
}));

vi.mock('@/lib/server/documents/blobstore', () => ({
  TEMP_DOCUMENT_UPLOAD_TTL_MS: 24 * 60 * 60 * 1000,
  copyObjectKeyToDocument: hoisted.copyObjectKeyToDocument,
  copyTempDocumentBlobToDocument: hoisted.copyTempDocumentBlobToDocument,
  deleteTempDocumentUpload: hoisted.deleteTempDocumentUpload,
  getTempDocumentBlob: hoisted.getTempDocumentBlob,
  getTempDocumentFinalizeReceipt: hoisted.getTempDocumentFinalizeReceipt,
  headDocumentBlob: hoisted.headDocumentBlob,
  headTempDocumentBlob: hoisted.headTempDocumentBlob,
  isMissingBlobError: vi.fn((error: unknown) => {
    const maybe = error as { code?: string } | undefined;
    return maybe?.code === 'NoSuchKey';
  }),
  isPreconditionFailed: vi.fn(() => false),
  isValidTempUploadToken: vi.fn(() => true),
  isDocumentBlobIntegrityError: vi.fn((error: unknown) =>
    (error as { code?: string } | null)?.code === 'DOCUMENT_BLOB_INTEGRITY_MISMATCH'),
  putTempDocumentFinalizeReceipt: hoisted.putTempDocumentFinalizeReceipt,
  tempDocumentUploadKey: hoisted.tempDocumentUploadKey,
  verifyDocumentBlobIntegrity: hoisted.verifyDocumentBlobIntegrity,
}));

vi.mock('@/lib/server/storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
}));

vi.mock('@/lib/server/runtime-config', () => ({
  getResolvedRuntimeConfig: vi.fn(async () => ({ computeLimitPolicies: {} })),
}));

vi.mock('@/lib/server/compute-limits/run-admitted', () => ({
  createAdmittedComputeOperation: hoisted.createAdmittedComputeOperation,
}));

vi.mock('@/lib/server/logger', () => ({
  errorToLog: vi.fn((error: unknown) => error),
  serverLogger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const token = '123e4567-e89b-12d3-a456-426614174000';
const lastModified = Date.now();

function input() {
  return { upload: { token, name: 'Report.docx', type: 'docx' as const, lastModified, folderId: undefined, hints: {} },
    userId: 'user-1', namespace: null, subject: { userId: 'user-1', isAnonymous: false }, schedulePreview: () => undefined, expectedSize: 12 };
}

describe('DOCX upload finalization', () => {
  beforeEach(() => {
    hoisted.requireAuthContext.mockReset();
    hoisted.registerUploadedDocument.mockReset();
    hoisted.isComputeWorkerAvailable.mockReset();
    hoisted.resolveDocumentConversion.mockReset();
    hoisted.createDocumentConversionOperation.mockReset();
    hoisted.headTempDocumentBlob.mockReset();
    hoisted.getTempDocumentBlob.mockReset();
    hoisted.getTempDocumentFinalizeReceipt.mockReset();
    hoisted.putTempDocumentFinalizeReceipt.mockReset();
    hoisted.deleteTempDocumentUpload.mockReset();
    hoisted.headDocumentBlob.mockReset();
    hoisted.copyTempDocumentBlobToDocument.mockReset();
    hoisted.copyObjectKeyToDocument.mockReset();
    hoisted.tempDocumentUploadKey.mockReset();
    hoisted.verifyDocumentBlobIntegrity.mockReset();
    hoisted.verifyDocumentBlobIntegrity.mockResolvedValue(9);
    hoisted.createAdmittedComputeOperation.mockReset();
    hoisted.createAdmittedComputeOperation.mockImplementation(
      async (input: { create: () => Promise<unknown> }) => input.create(),
    );

    hoisted.requireAuthContext.mockResolvedValue({ userId: 'user-1' });
    hoisted.isComputeWorkerAvailable.mockReturnValue(true);
    hoisted.getTempDocumentFinalizeReceipt.mockResolvedValue(null);
    hoisted.headTempDocumentBlob.mockResolvedValue({
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      contentLength: 12,
      lastModified,
      eTag: 'source-etag',
    });
    hoisted.tempDocumentUploadKey.mockReturnValue(`openreader/document_uploads_temp_v1/users/user-1/${token}.bin`);
    hoisted.headDocumentBlob
      .mockRejectedValueOnce({ code: 'NoSuchKey' })
      .mockResolvedValue({
        contentLength: 9,
        contentType: 'application/pdf',
        eTag: 'pdf-etag',
      });
    hoisted.registerUploadedDocument.mockImplementation(async (input: { documentId: string; name: string; type: string; size: number; lastModified: number }) => ({
      id: input.documentId,
      name: input.name,
      type: input.type,
      size: input.size,
      lastModified: input.lastModified,
      scope: 'user',
    }));
    hoisted.putTempDocumentFinalizeReceipt.mockResolvedValue(undefined);
    hoisted.deleteTempDocumentUpload.mockResolvedValue(undefined);
  });

  test('creates a worker conversion job without reading or converting DOCX bytes in Next', async () => {
    hoisted.resolveDocumentConversion.mockResolvedValue({ artifact: null, operation: null });
    hoisted.createDocumentConversionOperation.mockResolvedValue({
      opId: 'op-docx-1',
      subject: { kind: 'document_conversion', conversionId: 'conversion-1', namespace: null },
      status: 'queued',
      queuedAt: 1,
      updatedAt: 1,
    });

    const { finalizeUploadedDocument } = await import('@/lib/server/documents/finalize-upload');
    const response = await finalizeUploadedDocument(input());

    expect(response).toMatchObject({
      kind: 'pending',
      pending: {
        token,
        name: 'Report.docx',
        opId: 'op-docx-1',
        status: 'queued',
      },
    });
    expect(hoisted.getTempDocumentBlob).not.toHaveBeenCalled();
    expect(hoisted.copyTempDocumentBlobToDocument).not.toHaveBeenCalled();
    expect(hoisted.copyObjectKeyToDocument).not.toHaveBeenCalled();
    expect(hoisted.registerUploadedDocument).not.toHaveBeenCalled();
  });

  test('reads an existing conversion without spending admission again', async () => {
    hoisted.resolveDocumentConversion.mockResolvedValue({ artifact: null, operation: {
      opId: 'existing-conversion', status: 'running',
    } });
    const { finalizeUploadedDocument } = await import('@/lib/server/documents/finalize-upload');
    expect(await finalizeUploadedDocument(input())).toMatchObject({ kind: 'pending', pending: {
      opId: 'existing-conversion', status: 'running',
    } });
    expect(hoisted.createAdmittedComputeOperation).not.toHaveBeenCalled();
    expect(hoisted.createDocumentConversionOperation).not.toHaveBeenCalled();
  });

  test('registers a completed worker PDF artifact with a short finalize call', async () => {
    hoisted.resolveDocumentConversion.mockResolvedValue({
      artifact: {
        schemaVersion: 1,
        conversionId: 'conversion-1',
        namespace: null,
        sourceObjectKey: `openreader/document_uploads_temp_v1/users/user-1/${token}.bin`,
        sourceLastModifiedMs: lastModified,
        sourceContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sourceEtag: 'source-etag',
        converterVersion: 'docx-to-pdf@libreoffice-v1',
        objectKey: 'openreader/document_conversions_v1/docx/ns/_default/conversion-1/artifact.pdf',
        metadataObjectKey: 'openreader/document_conversions_v1/docx/ns/_default/conversion-1/metadata.json',
        contentType: 'application/pdf',
        byteLength: 9,
        documentId: 'a'.repeat(64),
        status: 'ready',
        createdAt: 2,
      },
      operation: {
        opId: 'op-docx-1',
        subject: { kind: 'document_conversion', conversionId: 'conversion-1', namespace: null },
        status: 'succeeded',
        queuedAt: 1,
        updatedAt: 2,
      },
    });

    const { finalizeUploadedDocument } = await import('@/lib/server/documents/finalize-upload');
    const response = await finalizeUploadedDocument(input());

    expect(response).toMatchObject({
      kind: 'stored',
      stored: {
        id: 'a'.repeat(64),
        name: 'Report.pdf',
        type: 'pdf',
      },
    });
    expect(hoisted.createDocumentConversionOperation).not.toHaveBeenCalled();
    expect(hoisted.getTempDocumentBlob).not.toHaveBeenCalled();
    expect(hoisted.copyObjectKeyToDocument).toHaveBeenCalledWith(
      'openreader/document_conversions_v1/docx/ns/_default/conversion-1/artifact.pdf',
      'a'.repeat(64),
      null,
      'application/pdf',
      { ifNoneMatch: true },
    );
    expect(hoisted.verifyDocumentBlobIntegrity).toHaveBeenCalledWith('a'.repeat(64), null, 9);
    expect(hoisted.registerUploadedDocument).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'a'.repeat(64),
      name: 'Report.pdf',
      type: 'pdf',
      folderId: undefined,
    }));
  });

  test('does not register a DOCX-generated PDF whose permanent blob fails integrity verification', async () => {
    hoisted.resolveDocumentConversion.mockResolvedValue({
      artifact: {
        schemaVersion: 1,
        conversionId: 'conversion-1',
        namespace: null,
        sourceObjectKey: 'openreader/docx/source.bin',
        sourceLastModifiedMs: lastModified,
        sourceContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        sourceEtag: 'source-etag',
        converterVersion: 'docx-to-pdf@libreoffice-v1',
        objectKey: 'openreader/document_conversions_v1/docx/ns/_default/conversion-1/artifact.pdf',
        metadataObjectKey: 'openreader/document_conversions_v1/docx/ns/_default/conversion-1/metadata.json',
        contentType: 'application/pdf',
        byteLength: 9,
        documentId: 'a'.repeat(64),
        status: 'ready',
        createdAt: 2,
      },
      operation: null,
    });
    const integrityError = Object.assign(new Error('Stored document failed integrity check'), {
      code: 'DOCUMENT_BLOB_INTEGRITY_MISMATCH',
    });
    hoisted.verifyDocumentBlobIntegrity.mockRejectedValue(integrityError);

    const { finalizeUploadedDocument } = await import('@/lib/server/documents/finalize-upload');
    await expect(finalizeUploadedDocument(input())).rejects.toThrow('Stored document failed integrity check');
    expect(hoisted.verifyDocumentBlobIntegrity).toHaveBeenCalledTimes(2);
    expect(hoisted.registerUploadedDocument).not.toHaveBeenCalled();
    expect(hoisted.putTempDocumentFinalizeReceipt).not.toHaveBeenCalled();
    expect(hoisted.deleteTempDocumentUpload).not.toHaveBeenCalled();
  });

  test('never converts bytes that differ from the declared size', async () => {
    const { finalizeUploadedDocument } = await import('@/lib/server/documents/finalize-upload');
    await expect(finalizeUploadedDocument({ ...input(), expectedSize: 11 })).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE', status: 400 });
    expect(hoisted.createDocumentConversionOperation).not.toHaveBeenCalled();
  });

  test('reports a missing worker as a retryable service error', async () => {
    hoisted.isComputeWorkerAvailable.mockReturnValue(false);
    const { finalizeUploadedDocument } = await import('@/lib/server/documents/finalize-upload');
    await expect(finalizeUploadedDocument(input())).rejects.toMatchObject({ code: 'COMPUTE_WORKER_REQUIRED', status: 503 });
  });

});

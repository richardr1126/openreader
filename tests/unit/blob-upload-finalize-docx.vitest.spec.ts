import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

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
  putTempDocumentFinalizeReceipt: hoisted.putTempDocumentFinalizeReceipt,
  tempDocumentUploadKey: hoisted.tempDocumentUploadKey,
}));

vi.mock('@/lib/server/testing/test-namespace', () => ({
  getOpenReaderTestNamespace: vi.fn(() => null),
}));

vi.mock('@/lib/server/storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
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

function finalizeRequest() {
  return new NextRequest('http://localhost/api/documents/blob/upload/finalize', {
    method: 'POST',
    body: JSON.stringify({
      uploads: [{
        token,
        name: 'Report.docx',
        type: 'docx',
        lastModified,
      }],
    }),
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

describe('POST /api/documents/blob/upload/finalize DOCX flow', () => {
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

    const { POST } = await import('../../src/app/api/documents/blob/upload/finalize/route');
    const response = await POST(finalizeRequest());

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      stored: [],
      conversions: [{
        token,
        name: 'Report.docx',
        opId: 'op-docx-1',
        status: 'queued',
      }],
    });
    expect(hoisted.getTempDocumentBlob).not.toHaveBeenCalled();
    expect(hoisted.copyTempDocumentBlobToDocument).not.toHaveBeenCalled();
    expect(hoisted.copyObjectKeyToDocument).not.toHaveBeenCalled();
    expect(hoisted.registerUploadedDocument).not.toHaveBeenCalled();
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

    const { POST } = await import('../../src/app/api/documents/blob/upload/finalize/route');
    const response = await POST(finalizeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stored: [{
        id: 'a'.repeat(64),
        name: 'Report.pdf',
        type: 'pdf',
      }],
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
    expect(hoisted.registerUploadedDocument).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'a'.repeat(64),
      name: 'Report.pdf',
      type: 'pdf',
    }));
  });
});

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const hoisted = vi.hoisted(() => ({
  requireAuthContext: vi.fn(),
  registerUploadedDocument: vi.fn(),
  convertDocxBufferToPdfBuffer: vi.fn(),
  headTempDocumentBlob: vi.fn(),
  getTempDocumentBlob: vi.fn(),
  getTempDocumentFinalizeReceipt: vi.fn(),
  putTempDocumentFinalizeReceipt: vi.fn(),
  deleteTempDocumentUpload: vi.fn(),
  headDocumentBlob: vi.fn(),
  copyTempDocumentBlobToDocument: vi.fn(),
  putDocumentBlob: vi.fn(),
}));

vi.mock('@/lib/server/auth/auth', () => ({
  requireAuthContext: hoisted.requireAuthContext,
}));

vi.mock('@/lib/server/documents/register-upload', () => ({
  registerUploadedDocument: hoisted.registerUploadedDocument,
}));

vi.mock('@/lib/server/documents/docx-convert', () => ({
  convertDocxBufferToPdfBuffer: hoisted.convertDocxBufferToPdfBuffer,
}));

vi.mock('@/lib/server/documents/blobstore', () => ({
  TEMP_DOCUMENT_UPLOAD_TTL_MS: 24 * 60 * 60 * 1000,
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
  putDocumentBlob: hoisted.putDocumentBlob,
  putTempDocumentFinalizeReceipt: hoisted.putTempDocumentFinalizeReceipt,
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

describe('POST /api/documents/blob/upload/finalize DOCX flow', () => {
  beforeEach(() => {
    hoisted.requireAuthContext.mockReset();
    hoisted.registerUploadedDocument.mockReset();
    hoisted.convertDocxBufferToPdfBuffer.mockReset();
    hoisted.headTempDocumentBlob.mockReset();
    hoisted.getTempDocumentBlob.mockReset();
    hoisted.getTempDocumentFinalizeReceipt.mockReset();
    hoisted.putTempDocumentFinalizeReceipt.mockReset();
    hoisted.deleteTempDocumentUpload.mockReset();
    hoisted.headDocumentBlob.mockReset();
    hoisted.copyTempDocumentBlobToDocument.mockReset();
    hoisted.putDocumentBlob.mockReset();

    hoisted.requireAuthContext.mockResolvedValue({ userId: 'user-1' });
    hoisted.getTempDocumentFinalizeReceipt.mockResolvedValue(null);
    hoisted.headTempDocumentBlob.mockResolvedValue({
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      contentLength: 12,
      lastModified: Date.now(),
    });
    hoisted.getTempDocumentBlob.mockResolvedValue(Buffer.from('docx-bytes'));
    hoisted.convertDocxBufferToPdfBuffer.mockResolvedValue(Buffer.from('pdf-bytes'));
    hoisted.headDocumentBlob
      .mockRejectedValueOnce({ code: 'NoSuchKey' })
      .mockResolvedValue({
        contentLength: Buffer.byteLength('pdf-bytes'),
        contentType: 'application/pdf',
        eTag: 'etag-1',
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

  test('converts raw DOCX during finalize and registers a PDF', async () => {
    const { POST } = await import('../../src/app/api/documents/blob/upload/finalize/route');
    const request = new NextRequest('http://localhost/api/documents/blob/upload/finalize', {
      method: 'POST',
      body: JSON.stringify({
        uploads: [{
          token: '123e4567-e89b-12d3-a456-426614174000',
          name: 'Report.docx',
          type: 'docx',
          lastModified: 1700000000000,
        }],
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const response = await POST(request);
    const expectedId = createHash('sha256').update(Buffer.from('pdf-bytes')).digest('hex');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      stored: [{
        id: expectedId,
        name: 'Report.pdf',
        type: 'pdf',
      }],
    });
    expect(hoisted.convertDocxBufferToPdfBuffer).toHaveBeenCalledTimes(1);
    expect(hoisted.putDocumentBlob).toHaveBeenCalledWith(
      expectedId,
      Buffer.from('pdf-bytes'),
      'application/pdf',
      null,
      { ifNoneMatch: true },
    );
    expect(hoisted.copyTempDocumentBlobToDocument).not.toHaveBeenCalled();
    expect(hoisted.registerUploadedDocument).toHaveBeenCalledWith(expect.objectContaining({
      documentId: expectedId,
      name: 'Report.pdf',
      type: 'pdf',
    }));
  });
});

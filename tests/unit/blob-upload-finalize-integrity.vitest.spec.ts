import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createServerAppError } from '@/lib/server/errors/contract';

const hoisted = vi.hoisted(() => ({
  requireAuthContext: vi.fn(),
  registerUploadedDocument: vi.fn(),
  headTempDocumentBlob: vi.fn(),
  getTempDocumentBlob: vi.fn(),
  getTempDocumentFinalizeReceipt: vi.fn(),
  putTempDocumentFinalizeReceipt: vi.fn(),
  deleteTempDocumentUpload: vi.fn(),
  headDocumentBlob: vi.fn(),
  copyTempDocumentBlobToDocument: vi.fn(),
  verifyDocumentBlobIntegrity: vi.fn(),
}));

vi.mock('@/lib/server/auth/auth', () => ({
  requireAuthContext: hoisted.requireAuthContext,
}));
vi.mock('@/lib/server/documents/register-upload', () => ({
  registerUploadedDocument: hoisted.registerUploadedDocument,
}));
vi.mock('@/lib/server/documents/blob-lease', () => ({
  withDocumentBlobLease: vi.fn(async (_id: string, task: () => Promise<unknown>) => task()),
}));
vi.mock('@/lib/server/documents/blobstore', () => ({
  TEMP_DOCUMENT_UPLOAD_TTL_MS: 24 * 60 * 60 * 1000,
  getTempDocumentBlob: hoisted.getTempDocumentBlob,
  getTempDocumentFinalizeReceipt: hoisted.getTempDocumentFinalizeReceipt,
  headTempDocumentBlob: hoisted.headTempDocumentBlob,
  headDocumentBlob: hoisted.headDocumentBlob,
  copyTempDocumentBlobToDocument: hoisted.copyTempDocumentBlobToDocument,
  verifyDocumentBlobIntegrity: hoisted.verifyDocumentBlobIntegrity,
  putTempDocumentFinalizeReceipt: hoisted.putTempDocumentFinalizeReceipt,
  deleteTempDocumentUpload: hoisted.deleteTempDocumentUpload,
  isDocumentBlobIntegrityError: (err: unknown) => (
    (err as { code?: string } | null)?.code === 'DOCUMENT_BLOB_INTEGRITY_MISMATCH'
  ),
  isMissingBlobError: (err: unknown) => (
    (err as { code?: string } | null)?.code === 'NoSuchKey'
  ),
  isPreconditionFailed: (err: unknown) => (
    (err as { status?: number } | null)?.status === 412
  ),
  isValidTempUploadToken: vi.fn(() => true),
}));
vi.mock('@/lib/server/storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
}));
vi.mock('@/lib/server/logger', () => ({
  errorToLog: vi.fn((error: unknown) => error),
  serverLogger: { warn: vi.fn(), error: vi.fn() },
}));

const token = '123e4567-e89b-12d3-a456-426614174000';
const source = Buffer.from('some document bytes to store');
const documentId = createHash('sha256').update(source).digest('hex');

function mismatchError() {
  return createServerAppError({
    code: 'DOCUMENT_BLOB_INTEGRITY_MISMATCH',
    message: 'Stored document failed integrity check',
    errorClass: 'storage',
  });
}

function request() {
  return new NextRequest('http://localhost/api/documents/blob/upload/finalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploads: [{ token, name: 'Book.pdf', type: 'pdf', lastModified: Date.now() }],
    }),
  });
}

describe('document upload finalization integrity boundary', () => {
  beforeEach(() => {
    for (const stub of Object.values(hoisted)) stub.mockReset();
    hoisted.requireAuthContext.mockResolvedValue({ userId: 'test-user' });
    hoisted.getTempDocumentFinalizeReceipt.mockResolvedValue(null);
    hoisted.headTempDocumentBlob.mockResolvedValue({
      contentLength: source.length,
      contentType: 'application/pdf',
      lastModified: Date.now(),
    });
    hoisted.getTempDocumentBlob.mockResolvedValue(source);
    hoisted.headDocumentBlob.mockResolvedValue({
      contentLength: source.length,
      contentType: 'application/pdf',
    });
    hoisted.verifyDocumentBlobIntegrity.mockResolvedValue(source.length);
    hoisted.registerUploadedDocument.mockImplementation(async (input) => ({
      id: input.documentId,
      name: input.name,
      type: input.type,
      size: input.size,
      lastModified: input.lastModified,
      scope: 'user',
    }));
    hoisted.copyTempDocumentBlobToDocument.mockResolvedValue(undefined);
    hoisted.putTempDocumentFinalizeReceipt.mockResolvedValue(undefined);
    hoisted.deleteTempDocumentUpload.mockResolvedValue(undefined);
  });

  test('registers verified canonical bytes and writes a success receipt', async () => {
    const { POST } = await import('../../src/app/api/documents/blob/upload/finalize/route');
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(hoisted.verifyDocumentBlobIntegrity).toHaveBeenCalledWith(documentId, null, source.length);
    expect(hoisted.registerUploadedDocument).toHaveBeenCalledOnce();
    expect(hoisted.putTempDocumentFinalizeReceipt).toHaveBeenCalledOnce();
    expect(hoisted.deleteTempDocumentUpload).toHaveBeenCalledOnce();
    expect(hoisted.copyTempDocumentBlobToDocument).not.toHaveBeenCalled();
  });

  test('copies a missing canonical object conditionally before verifying it', async () => {
    hoisted.headDocumentBlob.mockRejectedValueOnce({ code: 'NoSuchKey' });
    const { POST } = await import('../../src/app/api/documents/blob/upload/finalize/route');
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(hoisted.copyTempDocumentBlobToDocument).toHaveBeenCalledWith(
      token, 'test-user', documentId, null, 'application/pdf', { ifNoneMatch: true },
    );
  });

  test('recovers corrupt existing object with one replacement then re-verifies', async () => {
    hoisted.verifyDocumentBlobIntegrity.mockRejectedValueOnce(mismatchError())
      .mockResolvedValueOnce(source.length);
    const { POST } = await import('../../src/app/api/documents/blob/upload/finalize/route');
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(hoisted.copyTempDocumentBlobToDocument).toHaveBeenCalledTimes(1);
    expect(hoisted.copyTempDocumentBlobToDocument).toHaveBeenCalledWith(
      token, 'test-user', documentId, null, 'application/pdf', undefined,
    );
    expect(hoisted.verifyDocumentBlobIntegrity).toHaveBeenCalledTimes(2);
  });

  test('rejects persistent corruption without registration or success receipt', async () => {
    hoisted.verifyDocumentBlobIntegrity.mockRejectedValue(mismatchError());
    const { POST } = await import('../../src/app/api/documents/blob/upload/finalize/route');
    const res = await POST(request());
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      errorCode: 'DOCUMENT_BLOB_INTEGRITY_MISMATCH',
    });
    expect(hoisted.copyTempDocumentBlobToDocument).toHaveBeenCalledTimes(1);
    expect(hoisted.registerUploadedDocument).not.toHaveBeenCalled();
    expect(hoisted.putTempDocumentFinalizeReceipt).not.toHaveBeenCalled();
    expect(hoisted.deleteTempDocumentUpload).not.toHaveBeenCalled();
  });

  test('does not copy again when the verification read fails for another reason', async () => {
    hoisted.verifyDocumentBlobIntegrity.mockRejectedValueOnce(new Error('S3 connection interrupted'));
    const { POST } = await import('../../src/app/api/documents/blob/upload/finalize/route');
    const res = await POST(request());
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(hoisted.copyTempDocumentBlobToDocument).not.toHaveBeenCalled();
    expect(hoisted.registerUploadedDocument).not.toHaveBeenCalled();
    expect(hoisted.putTempDocumentFinalizeReceipt).not.toHaveBeenCalled();
  });

  test('re-verifies a receipt instead of blindly returning a stored result', async () => {
    hoisted.getTempDocumentFinalizeReceipt.mockResolvedValue({
      stored: { id: documentId, name: 'Book.pdf', type: 'pdf', size: source.length },
    });
    const { POST } = await import('../../src/app/api/documents/blob/upload/finalize/route');
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(hoisted.verifyDocumentBlobIntegrity).toHaveBeenCalledWith(documentId, null);
    expect(hoisted.getTempDocumentBlob).not.toHaveBeenCalled();
    expect(hoisted.registerUploadedDocument).not.toHaveBeenCalled();
  });

  test('returns the verified byte size when a legacy success receipt is stale', async () => {
    hoisted.getTempDocumentFinalizeReceipt.mockResolvedValue({
      stored: { id: documentId, name: 'Book.pdf', type: 'pdf', size: 10 },
    });
    const { POST } = await import('../../src/app/api/documents/blob/upload/finalize/route');
    const res = await POST(request());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      stored: [{ id: documentId, size: source.length }],
    });
    expect(hoisted.verifyDocumentBlobIntegrity).toHaveBeenCalledWith(documentId, null);
  });

  test('rejects a stale success receipt referencing a corrupt stored object', async () => {
    hoisted.getTempDocumentFinalizeReceipt.mockResolvedValue({
      stored: { id: documentId, name: 'Book.pdf', type: 'pdf', size: source.length },
    });
    hoisted.verifyDocumentBlobIntegrity.mockRejectedValue(mismatchError());
    const { POST } = await import('../../src/app/api/documents/blob/upload/finalize/route');
    const res = await POST(request());
    expect(res.status).toBe(503);
    expect(hoisted.registerUploadedDocument).not.toHaveBeenCalled();
    expect(hoisted.getTempDocumentBlob).not.toHaveBeenCalled();
  });

  test('handles concurrent conditional-create races by verifying the winner', async () => {
    hoisted.headDocumentBlob.mockRejectedValueOnce({ code: 'NoSuchKey' });
    hoisted.copyTempDocumentBlobToDocument.mockRejectedValueOnce({ status: 412 });
    const { POST } = await import('../../src/app/api/documents/blob/upload/finalize/route');
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(hoisted.verifyDocumentBlobIntegrity).toHaveBeenCalledOnce();
  });
});

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mock = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@/lib/server/storage/s3', () => ({
  getS3Config: vi.fn(() => ({ bucket: 'documents', prefix: 'openreader' })),
  getS3InternalClient: vi.fn(() => ({ send: mock.send })),
}));

import {
  isDocumentBlobIntegrityError,
  verifyDocumentBlobIntegrity,
} from '@/lib/server/documents/blobstore';

const payload = Buffer.from('%PDF-1.4\nfake PDF fixture\n%%EOF\n');
const documentId = createHash('sha256').update(payload).digest('hex');

function responseFor(bytes: Buffer, parts: number[] = [bytes.length]) {
  let offset = 0;
  const chunks = parts.map((part) => {
    const chunk = bytes.subarray(offset, offset + part);
    offset += part;
    return chunk;
  });
  if (offset < bytes.length) chunks.push(bytes.subarray(offset));
  return { Body: Readable.from(chunks), ContentLength: bytes.length };
}

describe('canonical document SHA-256 verification', () => {
  beforeEach(() => mock.send.mockReset());

  test('accepts complete stored bytes across multiple stream chunks', async () => {
    mock.send.mockResolvedValue(responseFor(payload, [3, 5, 2]));
    await expect(verifyDocumentBlobIntegrity(documentId, null, payload.length))
      .resolves.toBe(payload.length);
    expect(mock.send).toHaveBeenCalledOnce();
    expect(mock.send.mock.calls[0]?.[0]?.input).toMatchObject({
      Bucket: 'documents',
      Key: 'openreader/documents_v1/' + documentId,
    });
  });

  test('rejects a truncated object even when it begins with the correct bytes', async () => {
    mock.send.mockResolvedValue(responseFor(payload.subarray(0, 10)));
    await expect(verifyDocumentBlobIntegrity(documentId, null, payload.length))
      .rejects.toMatchObject({ code: 'DOCUMENT_BLOB_INTEGRITY_MISMATCH' });
  });

  test('rejects same-size corruption regardless of S3 ETag', async () => {
    const changed = Buffer.from(payload);
    changed[8] ^= 1;
    mock.send.mockResolvedValue({ ...responseFor(changed), ETag: documentId });
    await expect(verifyDocumentBlobIntegrity(documentId, null, changed.length))
      .rejects.toMatchObject({ code: 'DOCUMENT_BLOB_INTEGRITY_MISMATCH' });
  });

  test('verifies the full checksum even when the size is not provided', async () => {
    mock.send.mockResolvedValue(responseFor(payload.subarray(0, 4)));
    await expect(verifyDocumentBlobIntegrity(documentId, null))
      .rejects.toMatchObject({ code: 'DOCUMENT_BLOB_INTEGRITY_MISMATCH' });
  });

  test('fails closed when storage provides no response body', async () => {
    mock.send.mockResolvedValue({ Body: undefined, ContentLength: payload.length });
    await expect(verifyDocumentBlobIntegrity(documentId, null))
      .rejects.toMatchObject({ code: 'DOCUMENT_BLOB_INTEGRITY_MISMATCH' });
  });

  test('propagates interrupted S3 streams instead of recording success', async () => {
    const stream = Readable.from((async function* () {
      yield payload.subarray(0, 5);
      throw new Error('disconnected');
    })());
    mock.send.mockResolvedValue({ Body: stream });
    await expect(verifyDocumentBlobIntegrity(documentId, null))
      .rejects.toThrow('disconnected');
  });

  test('does not mistake unrelated storage errors for integrity mismatches', () => {
    expect(isDocumentBlobIntegrityError(new Error('network failure'))).toBe(false);
  });
});

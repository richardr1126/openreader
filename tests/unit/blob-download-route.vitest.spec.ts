import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const DOCUMENT_ID = 'a'.repeat(64);

const hoisted = vi.hoisted(() => ({
  requireAuthContext: vi.fn(),
  select: vi.fn(),
  limit: vi.fn(),
  getBrowserStorageTransport: vi.fn(),
  getDocumentBlobStream: vi.fn(),
  headDocumentBlob: vi.fn(),
  presignGet: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock('@openreader/database', () => ({
  db: {
    select: hoisted.select,
  },
}));

vi.mock('@openreader/database/schema', () => ({
  documents: {
    id: 'id',
    userId: 'userId',
  },
}));

vi.mock('@/lib/server/auth/auth', () => ({
  requireAuthContext: hoisted.requireAuthContext,
}));

vi.mock('@/lib/server/documents/blobstore', () => ({
  isValidDocumentId: vi.fn((id: string) => /^[a-f0-9]{64}$/.test(id)),
  getDocumentBlobStream: hoisted.getDocumentBlobStream,
  headDocumentBlob: hoisted.headDocumentBlob,
  presignGet: hoisted.presignGet,
}));

vi.mock('@/lib/server/storage/s3', () => ({
  getBrowserStorageTransport: hoisted.getBrowserStorageTransport,
  isS3Configured: vi.fn(() => true),
}));

describe('GET /api/documents/blob/get', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.requireAuthContext.mockResolvedValue({ userId: 'user-1' });
    hoisted.select.mockReturnValue({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: hoisted.limit,
        })),
      })),
    });
    hoisted.limit.mockResolvedValue([{ id: DOCUMENT_ID }]);
    hoisted.headDocumentBlob.mockResolvedValue({
      contentLength: 3,
      contentType: 'text/markdown',
      eTag: 'etag-1',
    });
    hoisted.getDocumentBlobStream.mockResolvedValue(new Uint8Array([1, 2, 3]));
    hoisted.presignGet.mockResolvedValue('https://s3.reader.example/openreader/document');
  });

  test('streams authorized document bytes in proxy mode', async () => {
    hoisted.getBrowserStorageTransport.mockReturnValue('proxy');
    const { GET } = await import('../../src/app/api/documents/blob/get/route');

    const response = await GET(new NextRequest(
      `http://localhost/api/documents/blob/get?id=${DOCUMENT_ID}`,
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown');
    expect(response.headers.get('content-length')).toBe('3');
    await expect(response.arrayBuffer()).resolves.toEqual(Uint8Array.from([1, 2, 3]).buffer);
    expect(hoisted.presignGet).not.toHaveBeenCalled();
  });

  test('redirects authorized document reads in presigned mode', async () => {
    hoisted.getBrowserStorageTransport.mockReturnValue('presigned');
    const { GET } = await import('../../src/app/api/documents/blob/get/route');

    const response = await GET(new NextRequest(
      `http://localhost/api/documents/blob/get?id=${DOCUMENT_ID}`,
    ));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://s3.reader.example/openreader/document');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(hoisted.presignGet).toHaveBeenCalledWith(DOCUMENT_ID, null);
    expect(hoisted.headDocumentBlob).not.toHaveBeenCalled();
    expect(hoisted.getDocumentBlobStream).not.toHaveBeenCalled();
  });
});

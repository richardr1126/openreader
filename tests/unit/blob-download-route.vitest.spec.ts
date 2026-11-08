import { beforeEach, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mock = vi.hoisted(() => ({ transport: 'proxy', stream: vi.fn(), head: vi.fn(), presign: vi.fn(), owned: vi.fn() }));
vi.mock('@/lib/server/api/principal', () => ({ resolveApiPrincipal: async () => ({ userId: 'owner', isAnonymous: false, scopes: ['documents:read'] }) }));
vi.mock('@/lib/server/documents/resources', () => ({ requireDocument: mock.owned }));
vi.mock('@/lib/server/documents/blobstore', () => ({ getDocumentBlobStream: mock.stream, headDocumentBlob: mock.head, presignGet: mock.presign, isMissingBlobError: () => false }));
vi.mock('@/lib/server/documents/finalize-upload', () => ({ UploadFolderError: class extends Error {} }));
vi.mock('@/lib/server/storage/s3', () => ({ isS3Configured: () => true, getBrowserStorageTransport: () => mock.transport }));
import { GET } from '@/app/api/v1/documents/[id]/file/route';
const id = 'a'.repeat(64);
const read = () => GET(new NextRequest(`http://localhost/api/v1/documents/${id}/file`), { params: Promise.resolve({ id }) });
beforeEach(() => {
  vi.clearAllMocks(); mock.transport = 'proxy';
  mock.owned.mockResolvedValue({ id, name: 'document.md' });
  mock.head.mockResolvedValue({ contentType: 'text/markdown', contentLength: 3 });
  mock.stream.mockResolvedValue(new Uint8Array([1, 2, 3]));
  mock.presign.mockResolvedValue('https://storage.example/document');
});
test('streams authorized document bytes in proxy mode', async () => {
  const response = await read();
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  expect(response.headers.get('content-disposition')).toContain('attachment');
  expect(response.headers.get('content-security-policy')).toContain('sandbox');
  expect(response.headers.get('content-length')).toBe('3');
  expect(await response.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
  expect(mock.presign).not.toHaveBeenCalled();
});
test('redirects authorized documents to signed storage without reading bytes', async () => {
  mock.transport = 'presigned';
  const response = await read();
  expect(response.status).toBe(307);
  expect(response.headers.get('location')).toBe('https://storage.example/document');
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(mock.presign).toHaveBeenCalledWith(expect.anything(), null, expect.objectContaining({
    contentType: 'text/markdown; charset=utf-8', disposition: expect.stringContaining('attachment'),
  }));
  expect(mock.head).not.toHaveBeenCalled();
  expect(mock.stream).not.toHaveBeenCalled();
});
test.each([
  ['page.html', 'text/plain; charset=utf-8'],
  ['image.svg', 'text/plain; charset=utf-8'],
  ['book.epub', 'application/epub+zip'],
])('serves %s as %s whatever storage recorded', async (name, type) => {
  mock.owned.mockResolvedValue({ id, name });
  mock.head.mockResolvedValue({ contentType: 'text/html', contentLength: 3 });
  const response = await read();
  expect(response.headers.get('content-type')).toBe(type);
});

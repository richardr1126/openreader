import { beforeEach, expect, test, vi } from 'vitest';
import type { DocumentCaller } from '@/lib/server/documents/request';

const mock = vi.hoisted(() => ({ transport: 'proxy', receipts: new Map<string, unknown>(), put: vi.fn(), presign: vi.fn() }));
vi.mock('@/lib/server/documents/blobstore', () => ({
  TEMP_DOCUMENT_UPLOAD_TTL_MS: 86400000,
  isValidTempUploadToken: (id: string) => /^[0-9a-f-]{36}$/.test(id),
  getTempDocumentFinalizeReceipt: async (id: string, owner: string) => mock.receipts.get(`${owner}:${id}`) ?? null,
  putTempDocumentFinalizeReceipt: async (id: string, owner: string, _namespace: unknown, bytes: Buffer) => { mock.receipts.set(`${owner}:${id}`, JSON.parse(bytes.toString())); },
  putTempDocumentBlob: mock.put, presignTempPut: mock.presign,
}));
vi.mock('@/lib/server/storage/s3', () => ({ getBrowserStorageTransport: () => mock.transport }));
vi.mock('@/lib/server/runtime-config', () => ({ getResolvedRuntimeConfig: async () => ({ maxUploadMb: 1 }) }));
import { prepareDocumentUpload, receiveDocumentUpload } from '@/lib/server/documents/uploads';

const caller = { principal: { userId: 'owner', isAnonymous: false, scopes: ['documents:write'] }, subject: { userId: 'owner', isAnonymous: false }, schedule: () => undefined } as DocumentCaller;
function stream(value: string) { return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(value)); controller.close(); } }); }
beforeEach(() => { vi.clearAllMocks(); mock.receipts.clear(); mock.transport = 'proxy'; mock.presign.mockResolvedValue({ url: 'https://storage.example/upload', headers: {} }); });
test('prepares an owned same-origin upload and receives exactly the declared bytes', async () => {
  const prepared = await prepareDocumentUpload(caller, { name: 'notes.txt', size: 5, contentType: 'text/plain' });
  expect(prepared.url).toBe(`/api/v1/uploads/${prepared.id}/file`);
  await receiveDocumentUpload(caller, prepared.id, stream('hello'));
  expect(mock.put).toHaveBeenCalledWith(prepared.id, 'owner', Buffer.from('hello'), 'text/plain', null);
});
test('rejects truncated bytes without writing them', async () => {
  const prepared = await prepareDocumentUpload(caller, { name: 'notes.txt', size: 5 });
  await expect(receiveDocumentUpload(caller, prepared.id, stream('four'))).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' });
  expect(mock.put).not.toHaveBeenCalled();
});
test('stops reading when the declared bound is exceeded', async () => {
  const prepared = await prepareDocumentUpload(caller, { name: 'notes.txt', size: 1 });
  await expect(receiveDocumentUpload(caller, prepared.id, stream('too large'))).rejects.toMatchObject({ status: 413 });
  expect(mock.put).not.toHaveBeenCalled();
});
test('an upload ID cannot be transferred by another owner', async () => {
  const prepared = await prepareDocumentUpload(caller, { name: 'notes.txt', size: 1 });
  await expect(receiveDocumentUpload({ ...caller, principal: { ...caller.principal, userId: 'other' } }, prepared.id, stream('a'))).rejects.toMatchObject({ status: 404 });
  expect(mock.put).not.toHaveBeenCalled();
});
test('presigned mode signs the declared content length and disallows proxy transfer', async () => {
  mock.transport = 'presigned';
  const prepared = await prepareDocumentUpload(caller, { name: 'notes.txt', size: 5, contentType: 'text/plain' });
  expect(prepared.url).toBe('https://storage.example/upload');
  expect(mock.presign).toHaveBeenCalledWith(prepared.id, 'owner', 'text/plain', null, { contentLength: 5 });
  await expect(receiveDocumentUpload(caller, prepared.id, stream('hello'))).rejects.toMatchObject({ status: 409 });
});
test('validates file type and configured size before preparing storage', async () => {
  await expect(prepareDocumentUpload(caller, { name: 'bad.exe', size: 5 })).rejects.toMatchObject({ status: 415 });
  await expect(prepareDocumentUpload(caller, { name: 'large.pdf', size: 2000000 })).rejects.toMatchObject({ status: 413 });
  expect(mock.receipts.size).toBe(0);
});

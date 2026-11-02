import { beforeEach, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { DocumentCaller } from '@/lib/server/documents/request';

const mock = vi.hoisted(() => ({ receipt: vi.fn(), head: vi.fn(), operation: vi.fn(), events: vi.fn() }));
vi.mock('@/lib/server/documents/blobstore', () => ({
  TEMP_DOCUMENT_UPLOAD_TTL_MS: 86400000, isValidTempUploadToken: () => true,
  getTempDocumentFinalizeReceipt: mock.receipt,
}));
vi.mock('@/lib/server/documents/docx-conversion-jobs', () => ({
  headTempUploadForConversion: mock.head,
  buildDocxConversionRequest: (input: { userId: string }) => ({ conversionId: `conversion-for-${input.userId}` }),
}));
vi.mock('@/lib/server/compute-worker/client', () => ({ getComputeWorkerClient: () => ({ getOperation: mock.operation, openOperationEvents: mock.events }) }));
import { authorizeUploadOperation } from '@/lib/server/documents/uploads';
const caller = { principal: { userId: 'owner', isAnonymous: false, scopes: ['documents:read'] }, subject: { userId: 'owner', isAnonymous: false }, schedule: () => undefined } as DocumentCaller;
beforeEach(() => {
  vi.clearAllMocks();
  mock.receipt.mockResolvedValue({ upload: { token: 'upload' }, createdAt: Date.now(), requested: true });
  mock.operation.mockResolvedValue({ subject: { kind: 'document_conversion', conversionId: 'conversion-for-owner', namespace: null } });
});
test('authorizes conversion events against the authenticated upload and its worker identity', async () => {
  expect(await authorizeUploadOperation(caller, 'upload', 'operation')).toBe(true);
  expect(mock.receipt).toHaveBeenCalledWith('upload', 'owner', null);
  expect(mock.head).toHaveBeenCalledWith({ token: 'upload', userId: 'owner', namespace: null });
});
test('rejects a conversion belonging to another upload or owner', async () => {
  mock.operation.mockResolvedValue({ subject: { kind: 'document_conversion', conversionId: 'conversion-for-other', namespace: null } });
  expect(await authorizeUploadOperation(caller, 'upload', 'operation')).toBe(false);
});
test('rejects missing or expired owned receipts before reading an operation', async () => {
  mock.receipt.mockResolvedValue(null);
  await expect(authorizeUploadOperation(caller, 'upload', 'operation')).rejects.toMatchObject({ status: 404 });
  expect(mock.operation).not.toHaveBeenCalled();
});

test('a failing event stream uses the API error shape and does not forward worker detail', async () => {
  mock.events.mockResolvedValue(new Response('internal worker detail', { status: 503 }));
  const { proxyOperationEvents } = await import('@/lib/server/compute-worker/operation-events-proxy');
  const response = await proxyOperationEvents({ request: new NextRequest('http://localhost/events'), opId: 'op', streamErrorMessage: 'Events are unavailable.' });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: 'OPERATION_EVENTS_UNAVAILABLE', message: 'Events are unavailable.' } });
});

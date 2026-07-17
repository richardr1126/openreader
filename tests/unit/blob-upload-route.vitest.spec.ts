import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const hoisted = vi.hoisted(() => ({
  requireAuthContext: vi.fn(),
  putTempDocumentBlob: vi.fn(),
  presignTempPut: vi.fn(),
  getBrowserStorageTransport: vi.fn(),
}));

vi.mock('@/lib/server/auth/auth', () => ({
  requireAuthContext: hoisted.requireAuthContext,
}));

vi.mock('@/lib/server/documents/blobstore', () => ({
  isValidTempUploadToken: vi.fn((token: string) => /^[0-9a-f-]{36}$/.test(token)),
  putTempDocumentBlob: hoisted.putTempDocumentBlob,
  presignTempPut: hoisted.presignTempPut,
}));

vi.mock('@/lib/server/runtime-config', () => ({
  getResolvedRuntimeConfig: vi.fn(async () => ({ maxUploadMb: 10 })),
}));

vi.mock('@/lib/server/storage/s3', () => ({
  getBrowserStorageTransport: hoisted.getBrowserStorageTransport,
  isS3Configured: vi.fn(() => true),
}));

vi.mock('@/lib/server/testing/test-namespace', () => ({
  getOpenReaderTestNamespace: vi.fn(() => null),
}));

describe('/api/documents/blob/upload proxy flow', () => {
  beforeEach(() => {
    hoisted.requireAuthContext.mockReset();
    hoisted.putTempDocumentBlob.mockReset();
    hoisted.presignTempPut.mockReset();
    hoisted.getBrowserStorageTransport.mockReset();

    hoisted.requireAuthContext.mockResolvedValue({ userId: 'user-1' });
    hoisted.getBrowserStorageTransport.mockReturnValue('proxy');
    hoisted.putTempDocumentBlob.mockResolvedValue(undefined);
  });

  test('prepares a same-origin PUT destination', async () => {
    const { POST } = await import('../../src/app/api/documents/blob/upload/route');
    const response = await POST(new NextRequest('http://localhost/api/documents/blob/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploads: [{ contentType: 'application/pdf', size: 5 }] }),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      transport: 'proxy',
      uploads: [{
        url: expect.stringMatching(/^\/api\/documents\/blob\/upload\?token=[0-9a-f-]{36}$/),
        headers: { 'Content-Type': 'application/pdf' },
      }],
    });
    expect(hoisted.presignTempPut).not.toHaveBeenCalled();
  });

  test('accepts the prepared proxy transfer with PUT', async () => {
    const token = '123e4567-e89b-12d3-a456-426614174000';
    const { PUT } = await import('../../src/app/api/documents/blob/upload/route');
    const response = await PUT(new NextRequest(
      `http://localhost/api/documents/blob/upload?token=${token}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: 'hello',
      },
    ));

    expect(response.status).toBe(204);
    expect(hoisted.putTempDocumentBlob).toHaveBeenCalledOnce();
    expect(hoisted.putTempDocumentBlob).toHaveBeenCalledWith(
      token,
      'user-1',
      Buffer.from('hello'),
      'application/pdf',
      null,
    );
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const hoisted = vi.hoisted(() => ({
  requireAuthContext: vi.fn(),
  isComputeWorkerAvailable: vi.fn(),
  isValidTempUploadToken: vi.fn(),
  headTempUploadForConversion: vi.fn(),
  buildDocxConversionRequest: vi.fn(),
  getOperation: vi.fn(),
  openOperationEvents: vi.fn(),
}));

vi.mock('@/lib/server/auth/auth', () => ({
  requireAuthContext: hoisted.requireAuthContext,
}));

vi.mock('@/lib/server/documents/blobstore', () => ({
  isValidTempUploadToken: hoisted.isValidTempUploadToken,
}));

vi.mock('@/lib/server/documents/docx-conversion-jobs', () => ({
  headTempUploadForConversion: hoisted.headTempUploadForConversion,
  buildDocxConversionRequest: hoisted.buildDocxConversionRequest,
}));

vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: hoisted.isComputeWorkerAvailable,
  getComputeWorkerClient: () => ({
    getOperation: hoisted.getOperation,
    openOperationEvents: hoisted.openOperationEvents,
  }),
}));

vi.mock('@/lib/server/logger', () => ({
  createRequestLogger: vi.fn(() => ({
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
    requestId: 'req-test',
  })),
}));

const token = '123e4567-e89b-12d3-a456-426614174000';

describe('GET /api/documents/blob/upload/events worker event proxy', () => {
  beforeEach(() => {
    hoisted.requireAuthContext.mockReset();
    hoisted.requireAuthContext.mockResolvedValue({ userId: 'user-1' });
    hoisted.isComputeWorkerAvailable.mockReset();
    hoisted.isComputeWorkerAvailable.mockReturnValue(true);
    hoisted.isValidTempUploadToken.mockReset();
    hoisted.isValidTempUploadToken.mockImplementation((candidate: string) => candidate === token);
    hoisted.headTempUploadForConversion.mockReset();
    hoisted.headTempUploadForConversion.mockResolvedValue({
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 12,
      lastModified: 123,
      eTag: 'source-etag',
    });
    hoisted.buildDocxConversionRequest.mockReset();
    hoisted.buildDocxConversionRequest.mockReturnValue({
      conversionId: 'conversion-1',
      namespace: null,
      sourceObjectKey: 'temp/source.docx',
      sourceLastModifiedMs: 123,
      sourceContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sourceEtag: 'source-etag',
    });
    hoisted.getOperation.mockReset();
    hoisted.getOperation.mockResolvedValue({
      opId: 'op-docx-1',
      subject: { kind: 'document_conversion', conversionId: 'conversion-1', namespace: null },
      status: 'running',
      queuedAt: 1,
      updatedAt: 2,
    });
    hoisted.openOperationEvents.mockReset();
    hoisted.openOperationEvents.mockResolvedValue(new Response(
      'event: snapshot\ndata: {"eventId":2,"snapshot":{"opId":"op-docx-1","status":"running"}}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
    ));
  });

  test('requires both the operation and a valid temporary upload token', async () => {
    const { GET } = await import('../../src/app/api/documents/blob/upload/events/route');
    const response = await GET(new NextRequest(
      'http://localhost/api/documents/blob/upload/events?opId=op-docx-1&token=invalid',
    ));

    expect(response.status).toBe(400);
    expect(hoisted.getOperation).not.toHaveBeenCalled();
    expect(hoisted.openOperationEvents).not.toHaveBeenCalled();
  });

  test('proxies conversion events after deriving authenticated upload ownership', async () => {
    const { GET } = await import('../../src/app/api/documents/blob/upload/events/route');
    const response = await GET(new NextRequest(
      `http://localhost/api/documents/blob/upload/events?opId=op-docx-1&token=${token}`,
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toContain('event: snapshot');
    expect(hoisted.headTempUploadForConversion).toHaveBeenCalledWith({
      token,
      userId: 'user-1',
      namespace: null,
    });
    expect(hoisted.buildDocxConversionRequest).toHaveBeenCalledWith(expect.objectContaining({
      upload: { token },
      userId: 'user-1',
      namespace: null,
    }));
    expect(hoisted.getOperation).toHaveBeenCalledWith('op-docx-1');
    expect(hoisted.openOperationEvents).toHaveBeenCalledWith('op-docx-1', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  test('denies an operation that does not match the authenticated upload', async () => {
    hoisted.getOperation.mockResolvedValue({
      opId: 'op-docx-1',
      subject: { kind: 'document_conversion', conversionId: 'other-conversion', namespace: null },
      status: 'running',
      queuedAt: 1,
      updatedAt: 2,
    });

    const { GET } = await import('../../src/app/api/documents/blob/upload/events/route');
    const response = await GET(new NextRequest(
      `http://localhost/api/documents/blob/upload/events?opId=op-docx-1&token=${token}`,
    ));

    expect(response.status).toBe(403);
    expect(hoisted.openOperationEvents).not.toHaveBeenCalled();
  });
});

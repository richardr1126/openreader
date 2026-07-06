import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const hoisted = vi.hoisted(() => ({
  validatePreviewRequest: vi.fn(),
  getOperation: vi.fn(),
  openOperationEvents: vi.fn(),
}));

vi.mock('@/app/api/documents/blob/preview/utils', () => ({
  validatePreviewRequest: hoisted.validatePreviewRequest,
}));

vi.mock('@/lib/server/compute-worker/client', () => ({
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

describe('GET /api/documents/blob/preview/events worker event proxy', () => {
  beforeEach(() => {
    hoisted.validatePreviewRequest.mockReset();
    hoisted.validatePreviewRequest.mockResolvedValue({
      doc: {
        id: 'doc-1',
        userId: 'user-1',
        type: 'pdf',
        lastModified: 123,
      },
      testNamespace: null,
      id: 'doc-1',
    });
    hoisted.getOperation.mockReset();
    hoisted.getOperation.mockResolvedValue({
      opId: 'op-preview-1',
      subject: {
        kind: 'document_preview',
        documentId: 'doc-1',
        namespace: null,
        previewKind: 'card',
      },
      status: 'running',
      queuedAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    hoisted.openOperationEvents.mockReset();
    hoisted.openOperationEvents.mockResolvedValue(new Response(
      'event: snapshot\ndata: {"eventId":1,"snapshot":{"opId":"op-preview-1","status":"running"}}\n\n',
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
        },
      },
    ));
  });

  test('requires an opId', async () => {
    const { GET } = await import('../../src/app/api/documents/blob/preview/events/route');
    const response = await GET(new NextRequest('http://localhost/api/documents/blob/preview/events?id=doc-1'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'opId is required' });
    expect(hoisted.openOperationEvents).not.toHaveBeenCalled();
  });

  test('proxies the worker SSE stream after validating preview ownership', async () => {
    const { GET } = await import('../../src/app/api/documents/blob/preview/events/route');
    const response = await GET(new NextRequest('http://localhost/api/documents/blob/preview/events?id=doc-1&opId=op-preview-1'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('event: snapshot');
    expect(text).toContain('"opId":"op-preview-1"');
    expect(hoisted.getOperation).toHaveBeenCalledWith('op-preview-1');
    expect(hoisted.openOperationEvents).toHaveBeenCalledWith('op-preview-1', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });

  test('denies proxying when the op does not belong to the preview', async () => {
    hoisted.getOperation.mockResolvedValue({
      opId: 'op-preview-1',
      subject: {
        kind: 'document_preview',
        documentId: 'other-doc',
        namespace: null,
        previewKind: 'card',
      },
      status: 'running',
      queuedAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });

    const { GET } = await import('../../src/app/api/documents/blob/preview/events/route');
    const response = await GET(new NextRequest('http://localhost/api/documents/blob/preview/events?id=doc-1&opId=op-preview-1'));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'Operation does not belong to this preview' });
    expect(hoisted.openOperationEvents).not.toHaveBeenCalled();
  });
});

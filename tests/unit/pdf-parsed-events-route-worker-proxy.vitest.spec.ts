import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const hoisted = vi.hoisted(() => ({
  db: null as {
    select: ReturnType<typeof vi.fn>;
  } | null,
  row: {
    id: 'doc-1',
    type: 'pdf',
  },
  requireAuthContext: vi.fn(),
  fetchPdfParseOperation: vi.fn(),
  isPdfParseOperationForDocument: vi.fn(),
  getWorkerClientConfigFromEnv: vi.fn(),
}));

vi.mock('@/db', () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock('@/lib/server/auth/auth', () => ({
  requireAuthContext: hoisted.requireAuthContext,
}));

vi.mock('@/lib/server/pdf-parse/operation', () => ({
  fetchPdfParseOperation: hoisted.fetchPdfParseOperation,
  isPdfParseOperationForDocument: hoisted.isPdfParseOperationForDocument,
}));

vi.mock('@/lib/server/compute/worker', () => ({
  getWorkerClientConfigFromEnv: hoisted.getWorkerClientConfigFromEnv,
}));

vi.mock('@/lib/server/documents/blobstore', () => ({
  isValidDocumentId: vi.fn(() => true),
}));

vi.mock('@/lib/server/storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
}));

vi.mock('@/lib/server/testing/test-namespace', () => ({
  getOpenReaderTestNamespace: vi.fn(() => null),
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

describe('GET /api/documents/[id]/parsed/events worker event proxy', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    hoisted.db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ ...hoisted.row }]),
          })),
        })),
      })),
    };
    hoisted.requireAuthContext.mockReset();
    hoisted.requireAuthContext.mockResolvedValue({ userId: 'user-1' });
    hoisted.fetchPdfParseOperation.mockReset();
    hoisted.fetchPdfParseOperation.mockResolvedValue({
      opId: 'op-1',
      opKey: 'pdf_layout|v1|parser|doc-1||doc-key|',
      kind: 'pdf_layout',
      jobId: 'job-1',
      status: 'running',
      queuedAt: Date.now() - 1000,
      updatedAt: Date.now(),
    });
    hoisted.isPdfParseOperationForDocument.mockReset();
    hoisted.isPdfParseOperationForDocument.mockReturnValue(true);
    hoisted.getWorkerClientConfigFromEnv.mockReset();
    hoisted.getWorkerClientConfigFromEnv.mockReturnValue({
      baseUrl: 'http://worker.local',
      token: 'worker-token',
    });
    global.fetch = vi.fn(async () => new Response(
      'event: snapshot\ndata: {"eventId":1,"snapshot":{"opId":"op-1","status":"running"}}\n\n',
      {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
        },
      },
    )) as typeof fetch;
  });

  test('requires an opId', async () => {
    const { GET } = await import('../../src/app/api/documents/[id]/parsed/events/route');
    const response = await GET(new NextRequest('http://localhost/api/documents/doc-1/parsed/events'), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'opId is required' });
  });

  test('proxies the worker SSE stream after validating document ownership', async () => {
    const { GET } = await import('../../src/app/api/documents/[id]/parsed/events/route');
    const response = await GET(new NextRequest('http://localhost/api/documents/doc-1/parsed/events?opId=op-1'), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('event: snapshot');
    expect(text).toContain('"opId":"op-1"');
    expect(hoisted.fetchPdfParseOperation).toHaveBeenCalledWith('op-1');
    expect(hoisted.isPdfParseOperationForDocument).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      'http://worker.local/ops/op-1/events',
      expect.anything(),
    );
  });

  test('denies proxying when the op does not belong to the document', async () => {
    hoisted.isPdfParseOperationForDocument.mockReturnValue(false);

    const { GET } = await import('../../src/app/api/documents/[id]/parsed/events/route');
    const response = await GET(new NextRequest('http://localhost/api/documents/doc-1/parsed/events?opId=op-1'), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'Operation not found' });
    expect(hoisted.fetchPdfParseOperation).toHaveBeenCalledWith('op-1');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });
});

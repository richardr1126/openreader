import { beforeEach, describe, expect, test, vi } from 'vitest';
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
  resolveCurrentPdfParse: vi.fn(),
  createOrReuseCurrentPdfParseOperation: vi.fn(),
  checkJobRate: vi.fn(),
  getPdfLayoutRateConfig: vi.fn(),
  getResolvedRuntimeConfig: vi.fn(),
  buildComputeRateLimitedResponse: vi.fn(),
}));

vi.mock('@openreader/database', () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock('@/lib/server/auth/auth', () => ({
  requireAuthContext: hoisted.requireAuthContext,
}));

vi.mock('@/lib/server/pdf-parse/operation', () => ({
  resolveCurrentPdfParse: hoisted.resolveCurrentPdfParse,
  createOrReuseCurrentPdfParseOperation: hoisted.createOrReuseCurrentPdfParseOperation,
}));

vi.mock('@/lib/server/rate-limit/job-rate-limiter', () => ({
  checkJobRate: hoisted.checkJobRate,
  getPdfLayoutRateConfig: hoisted.getPdfLayoutRateConfig,
}));

vi.mock('@/lib/server/rate-limit/problem-response', () => ({
  buildComputeRateLimitedResponse: hoisted.buildComputeRateLimitedResponse,
}));

vi.mock('@/lib/server/runtime-config', () => ({
  getResolvedRuntimeConfig: hoisted.getResolvedRuntimeConfig,
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

describe('GET/POST /api/documents/[id]/parsed worker flow', () => {
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
    hoisted.resolveCurrentPdfParse.mockReset();
    hoisted.resolveCurrentPdfParse.mockResolvedValue({ artifact: null, operation: null });
    hoisted.createOrReuseCurrentPdfParseOperation.mockReset();
    hoisted.checkJobRate.mockReset();
    hoisted.checkJobRate.mockResolvedValue({ allowed: true });
    hoisted.getPdfLayoutRateConfig.mockReset();
    hoisted.getPdfLayoutRateConfig.mockReturnValue({});
    hoisted.getResolvedRuntimeConfig.mockReset();
    hoisted.getResolvedRuntimeConfig.mockResolvedValue({});
    hoisted.buildComputeRateLimitedResponse.mockReset();
  });

  test('GET returns pending when no current artifact or worker op exists', async () => {
    const { GET } = await import('../../src/app/api/documents/[id]/parsed/route');
    const response = await GET(new NextRequest('http://localhost/api/documents/doc-1/parsed'), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      parseStatus: 'pending',
      parseProgress: null,
      opId: null,
    });
  });

  test('GET returns a ready control-plane snapshot when the worker artifact exists', async () => {
    hoisted.resolveCurrentPdfParse.mockResolvedValue({
      artifact: { objectKey: 'parsed-key.json' },
      operation: null,
    });

    const { GET } = await import('../../src/app/api/documents/[id]/parsed/route');
    const response = await GET(new NextRequest('http://localhost/api/documents/doc-1/parsed'), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ parseStatus: 'ready' });
  });

  test('POST creates a worker op when replace is requested', async () => {
    hoisted.createOrReuseCurrentPdfParseOperation.mockResolvedValue({
      opId: 'op-force-1',
      opKey: 'pdf_layout|v1|parser|doc-1||doc-key|force',
      kind: 'pdf_layout',
      jobId: 'job-force-1',
      status: 'queued',
      queuedAt: Date.now(),
      updatedAt: Date.now(),
    });

    const { POST } = await import('../../src/app/api/documents/[id]/parsed/route');
    const request = new NextRequest('http://localhost/api/documents/doc-1/parsed', {
      method: 'POST',
      body: JSON.stringify({ replace: true }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      parseStatus: 'pending',
      opId: 'op-force-1',
    });
    expect(hoisted.createOrReuseCurrentPdfParseOperation).toHaveBeenCalled();
  });

  test('POST keeps a succeeded operation pending until the worker resolves its artifact', async () => {
    hoisted.resolveCurrentPdfParse.mockResolvedValue({ artifact: null, operation: {
      opId: 'op-ready-1',
      opKey: 'pdf_layout|v1|parser|doc-1||doc-key|',
      kind: 'pdf_layout',
      jobId: 'job-ready-1',
      status: 'succeeded',
      queuedAt: Date.now() - 1000,
      updatedAt: Date.now(),
      result: { parsedObjectKey: 'missing-parsed-key.json' },
    } });

    const { POST } = await import('../../src/app/api/documents/[id]/parsed/route');
    const request = new NextRequest('http://localhost/api/documents/doc-1/parsed', {
      method: 'POST',
      body: JSON.stringify({ replace: false }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      parseStatus: 'running',
      opId: 'op-ready-1',
    });
    expect(hoisted.createOrReuseCurrentPdfParseOperation).not.toHaveBeenCalled();
  });

  test('POST returns the rate-limited response without creating a worker op', async () => {
    const sentinel = new Response('rate limited', { status: 429 });
    hoisted.checkJobRate.mockResolvedValue({ allowed: false });
    hoisted.buildComputeRateLimitedResponse.mockReturnValue(sentinel);

    const { POST } = await import('../../src/app/api/documents/[id]/parsed/route');
    const request = new NextRequest('http://localhost/api/documents/doc-1/parsed', {
      method: 'POST',
      body: JSON.stringify({ replace: true }),
      headers: { 'Content-Type': 'application/json' },
    });
    const response = await POST(request, {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response).toBe(sentinel);
    expect(hoisted.createOrReuseCurrentPdfParseOperation).not.toHaveBeenCalled();
  });
});

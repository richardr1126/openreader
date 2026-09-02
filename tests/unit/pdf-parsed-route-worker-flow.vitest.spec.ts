import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const hoisted = vi.hoisted(() => ({
  db: null as { select: ReturnType<typeof vi.fn> } | null,
  createOperation: vi.fn(),
  checkJobRate: vi.fn(),
  recordJobEvent: vi.fn(),
}));

vi.mock('@openreader/database', () => ({
  get db() {
    return hoisted.db;
  },
}));
vi.mock('@/lib/server/auth/auth', () => ({
  requireAuthContext: vi.fn(async () => ({ userId: 'user-1' })),
}));
vi.mock('@/lib/server/pdf-parse/operation', () => ({
  createOrReuseCurrentPdfParseOperation: hoisted.createOperation,
}));
vi.mock('@/lib/server/rate-limit/job-rate-limiter', () => ({
  checkJobRate: hoisted.checkJobRate,
  getPdfLayoutRateConfig: vi.fn(() => ({})),
  recordJobEvent: hoisted.recordJobEvent,
}));
vi.mock('@/lib/server/rate-limit/problem-response', () => ({
  buildComputeRateLimitedResponse: vi.fn(() => new Response('rate limited', { status: 429 })),
}));
vi.mock('@/lib/server/runtime-config', () => ({
  getResolvedRuntimeConfig: vi.fn(async () => ({})),
}));
vi.mock('@/lib/server/documents/blobstore', () => ({
  isValidDocumentId: vi.fn(() => true),
}));
vi.mock('@/lib/server/storage/s3', () => ({
  isS3Configured: vi.fn(() => true),
}));
vi.mock('@/lib/server/logger', () => ({
  createRequestLogger: vi.fn(() => ({ logger: {} })),
}));

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/documents/doc-1/parsed', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/documents/[id]/parsed', () => {
  beforeEach(() => {
    hoisted.db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [{ id: 'doc-1', type: 'pdf' }]),
          })),
        })),
      })),
    };
    hoisted.createOperation.mockReset();
    hoisted.createOperation.mockResolvedValue({
      opId: 'parse-op',
      status: 'queued',
      subject: { kind: 'pdf_layout', documentId: 'doc-1', namespace: null },
    });
    hoisted.checkJobRate.mockReset();
    hoisted.checkJobRate.mockResolvedValue({ allowed: true });
    hoisted.recordJobEvent.mockReset();
    hoisted.recordJobEvent.mockResolvedValue(undefined);
  });

  test('requires an explicit replacement command', async () => {
    const { POST } = await import('../../src/app/api/documents/[id]/parsed/route');
    const response = await POST(request({}), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(400);
    expect(hoisted.createOperation).not.toHaveBeenCalled();
  });

  test('starts a uniquely keyed replacement operation', async () => {
    const { POST } = await import('../../src/app/api/documents/[id]/parsed/route');
    const response = await POST(request({ replace: true }), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      parseStatus: 'pending',
      opId: 'parse-op',
    });
    expect(hoisted.createOperation).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'doc-1',
      forceToken: expect.any(String),
    }));
    expect(hoisted.recordJobEvent).toHaveBeenCalledWith(
      'user-1',
      'pdf_layout',
      'parse-op',
      {},
    );
  });

  test('does not create an operation when rate limited', async () => {
    hoisted.checkJobRate.mockResolvedValue({ allowed: false });
    const { POST } = await import('../../src/app/api/documents/[id]/parsed/route');
    const response = await POST(request({ replace: true }), {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(429);
    expect(hoisted.createOperation).not.toHaveBeenCalled();
  });
});

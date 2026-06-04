import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const hoisted = vi.hoisted(() => ({
  db: null as {
    select: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  } | null,
  row: {
    id: 'doc-1',
    userId: 'user-1',
    parseState: null as string | null,
  },
  requireAuthContext: vi.fn(),
  backfillPendingPdfParseOperation: vi.fn(),
  healStaleDocumentParseState: vi.fn(async ({ state }) => state),
}));

vi.mock('@/db', () => ({
  get db() {
    return hoisted.db;
  },
}));

vi.mock('@/lib/server/auth/auth', () => ({
  requireAuthContext: hoisted.requireAuthContext,
}));

vi.mock('@/lib/server/documents/parse-state-backfill', () => ({
  backfillPendingPdfParseOperation: hoisted.backfillPendingPdfParseOperation,
}));

vi.mock('@/lib/server/documents/parse-state-healing', () => ({
  healStaleDocumentParseState: hoisted.healStaleDocumentParseState,
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
  hashForLog: vi.fn(() => 'user-hash'),
}));

describe('GET /api/documents/[id]/parsed/events legacy backfill', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.COMPUTE_WORKER_URL = 'http://localhost:4010';
    process.env.COMPUTE_WORKER_TOKEN = 'worker-test-token';

    hoisted.row = {
      id: 'doc-1',
      userId: 'user-1',
      parseState: null,
    };
    hoisted.db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => ([{ ...hoisted.row }])),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: { parseState?: string | null }) => ({
          where: vi.fn(async () => {
            if (typeof values.parseState !== 'undefined') {
              hoisted.row.parseState = values.parseState;
            }
            return [];
          }),
        })),
      })),
    };
    hoisted.requireAuthContext.mockReset();
    hoisted.requireAuthContext.mockResolvedValue({ userId: 'user-1' });
    hoisted.backfillPendingPdfParseOperation.mockReset();
    hoisted.healStaleDocumentParseState.mockClear();

    global.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }
    })) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('creates a worker op for legacy pending PDFs without opId', async () => {
    hoisted.backfillPendingPdfParseOperation.mockResolvedValue({
      opId: 'op-legacy-1',
      opKey: 'pdf_layout|v1|doc-1||doc-1|',
      jobId: 'job-legacy-1',
      kind: 'pdf_layout',
      status: 'queued',
      queuedAt: Date.now(),
      progress: null,
      result: undefined,
      error: undefined,
      updatedAt: Date.now(),
    });

    const { GET } = await import('../../src/app/api/documents/[id]/parsed/events/route');
    const controller = new AbortController();
    const request = new NextRequest('http://localhost/api/documents/doc-1/parsed/events', {
      signal: controller.signal,
    });
    const response = await GET(request, {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const first = await reader!.read();
    const chunk = new TextDecoder().decode(first.value);
    expect(chunk).toContain('event: snapshot');
    expect(chunk).toContain('"parseStatus":"pending"');
    expect(chunk).toContain('"opId":"op-legacy-1"');

    controller.abort();
    await reader!.cancel().catch(() => {});

    expect(hoisted.backfillPendingPdfParseOperation).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'doc-1',
      userId: 'user-1',
      namespace: null,
      state: expect.objectContaining({ status: 'pending' }),
    }));
    const parseState = String(hoisted.row.parseState ?? '');
    expect(parseState).toContain('"status":"pending"');
    expect(parseState).toContain('"opId":"op-legacy-1"');
    expect(parseState).toContain('"jobId":"job-legacy-1"');
  });
});

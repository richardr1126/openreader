import { beforeEach, describe, expect, test, vi } from 'vitest';
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
    parsedJsonKey: null as string | null,
  },
  requireAuthContext: vi.fn(),
  fetchWorkerOperationState: vi.fn(),
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

vi.mock('@/lib/server/compute/worker-op-state', () => ({
  fetchWorkerOperationState: hoisted.fetchWorkerOperationState,
}));

vi.mock('@/lib/server/documents/parse-state-backfill', () => ({
  backfillPendingPdfParseOperation: hoisted.backfillPendingPdfParseOperation,
}));

vi.mock('@/lib/server/documents/parse-state-healing', () => ({
  healStaleDocumentParseState: hoisted.healStaleDocumentParseState,
}));

vi.mock('@/lib/server/documents/blobstore', () => ({
  documentKey: vi.fn(),
  getParsedDocumentBlob: vi.fn(),
  getParsedDocumentBlobByKey: vi.fn(),
  isMissingBlobError: vi.fn(() => false),
  isValidDocumentId: vi.fn(() => true),
  putParsedDocumentBlob: vi.fn(),
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

describe('GET /api/documents/[id]/parsed pure data fetch', () => {
  beforeEach(async () => {
    process.env.BASE_URL = 'http://localhost:3003';
    process.env.AUTH_SECRET = 'test-secret';

    hoisted.row = {
      id: 'doc-1',
      userId: 'user-1',
      parseState: null,
      parsedJsonKey: null,
    };
    hoisted.db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => ([{ ...hoisted.row }])),
        })),
      })),
      update: vi.fn(() => ({
        set: vi.fn((values: { parseState?: string | null; parsedJsonKey?: string | null }) => ({
          where: vi.fn(async () => {
            if (typeof values.parseState !== 'undefined') {
              hoisted.row.parseState = values.parseState;
            }
            if (typeof values.parsedJsonKey !== 'undefined') {
              hoisted.row.parsedJsonKey = values.parsedJsonKey;
            }
            return [];
          }),
        })),
      })),
    };
    hoisted.requireAuthContext.mockReset();
    hoisted.requireAuthContext.mockResolvedValue({ userId: 'user-1' });
    hoisted.fetchWorkerOperationState.mockReset();
    hoisted.fetchWorkerOperationState.mockResolvedValue(null);
    hoisted.backfillPendingPdfParseOperation.mockReset();
    hoisted.healStaleDocumentParseState.mockClear();
  });

  test('returns non-ready status without creating a worker op for legacy pending PDFs without opId', async () => {
    const { GET } = await import('../../src/app/api/documents/[id]/parsed/route');
    const request = new NextRequest('http://localhost/api/documents/doc-1/parsed');
    const response = await GET(request, {
      params: Promise.resolve({ id: 'doc-1' }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      parseStatus: 'pending',
      opId: null,
    });
    expect(hoisted.backfillPendingPdfParseOperation).not.toHaveBeenCalled();
    expect(hoisted.row.parseState).toBeNull();
  });
});

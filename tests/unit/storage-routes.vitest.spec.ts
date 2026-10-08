import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  usage: vi.fn(),
  reclaim: vi.fn(),
  owned: new Set<string>(),
  workerAvailable: true,
  authorized: true,
}));

vi.mock('@/lib/server/compute-worker/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/server/compute-worker/client')>(),
  isComputeWorkerAvailable: () => mocks.workerAvailable,
  getComputeWorkerClient: () => ({
    getUserStorageUsage: mocks.usage,
    reclaimTtsPlaybackCache: mocks.reclaim,
  }),
}));
vi.mock('@/lib/server/auth/auth', () => ({
  requireAuthContext: async () => (mocks.authorized
    ? { userId: 'user-1' }
    : Response.json({ error: 'Unauthorized' }, { status: 401 })),
}));
vi.mock('@/lib/server/tts/storage-scope', () => ({
  resolveDocumentStorageScope: async (request: NextRequest) => {
    const body = await request.json().catch(() => null) as { documentId?: string } | null;
    if (!body?.documentId) return Response.json({ error: 'Invalid request payload' }, { status: 400 });
    return {
      documentId: body.documentId,
      scope: { storageUserId: 'user-1', documentVersion: 3, readerType: 'pdf' },
      settingsHash: 'current-hash',
    };
  },
  listOwnedDocumentIds: async () => new Set(mocks.owned),
  filterOwnedDocumentIds: async (_userId: string, ids: string[]) => new Set(ids.filter((id) => mocks.owned.has(id))),
}));
vi.mock('@/lib/server/logger', () => ({
  createRequestLogger: () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }),
}));

import { POST as documentUsage } from '@/app/api/tts/storage/document/route';
import { POST as documentReclaim } from '@/app/api/tts/storage/document/reclaim/route';
import { GET as libraryUsage } from '@/app/api/tts/storage/route';
import { POST as libraryReclaim } from '@/app/api/tts/storage/reclaim/route';

const post = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, {
  method: 'POST', body: JSON.stringify(body),
});

const variant = (documentVersion: number, settingsHash: string, bytes: number) => (
  { documentVersion, settingsHash, bytes, objects: 1 }
);

const reclaimResult = {
  reclaimedVariants: 1, deletedAudioObjects: 2, deletedSidecarObjects: 1, deletedExportObjects: 0,
  invalidatedPlaybackSessions: 0, invalidatedJobOperations: 0,
};

describe('storage routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.owned = new Set();
    mocks.workerAvailable = true;
    mocks.authorized = true;
    mocks.reclaim.mockResolvedValue(reclaimResult);
  });

  test('measures one document against the current cache identity', async () => {
    mocks.usage.mockResolvedValueOnce({
      documents: [{
        documentId: 'doc-1',
        variants: [variant(3, 'current-hash', 120), variant(3, 'old-voice', 80)],
        exports: [],
        derivedBytes: 50,
        derivedObjects: 2,
      }],
      scannedObjects: 4,
      truncated: false,
    });
    const response = await documentUsage(post('/api/tts/storage/document', { documentId: 'doc-1' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      currentAudioBytes: 120, unusedAudioBytes: 80, documentDataBytes: 50, truncated: false,
    });
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({
      storageUserId: 'user-1', documentId: 'doc-1', derivedDocumentIds: ['doc-1'], includePlayback: true,
    }), expect.anything());
  });

  test('rejects invalid document payloads and reports a missing worker', async () => {
    expect((await documentUsage(post('/api/tts/storage/document', {}))).status).toBe(400);
    mocks.workerAvailable = false;
    expect((await documentUsage(post('/api/tts/storage/document', { documentId: 'doc-1' }))).status).toBe(503);
    expect((await documentReclaim(post('/api/tts/storage/document/reclaim', { documentId: 'doc-1' }))).status).toBe(503);
    expect(mocks.usage).not.toHaveBeenCalled();
    expect(mocks.reclaim).not.toHaveBeenCalled();
  });

  test('reports a retryable measurement timeout instead of a generic storage error', async () => {
    mocks.usage.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    const response = await documentUsage(post('/api/tts/storage/document', { documentId: 'doc-1' }));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect((await response.json()).error).toContain('Try again');
  });

  test('explains an older worker missing the storage endpoint', async () => {
    const { ComputeWorkerClient } = await import('@/lib/server/compute-worker/client');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Not found' }, { status: 404 })));
    try {
      const client = new ComputeWorkerClient({ baseUrl: 'http://worker.test', token: 'test-token' });
      const error = await client.getUserStorageUsage({ storageUserId: 'user-1', includePlayback: true,
        derivedDocumentIds: [], namespace: null })
        .catch((error: unknown) => error);
      mocks.usage.mockRejectedValueOnce(error);
      const response = await documentUsage(post('/api/tts/storage/document', { documentId: 'doc-1' }));
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain('Redeploy the worker to match the web version');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('reclaims a document while keeping the current version and settings', async () => {
    const response = await documentReclaim(post('/api/tts/storage/document/reclaim', { documentId: 'doc-1' }));
    expect(response.status).toBe(200);
    expect(mocks.reclaim).toHaveBeenCalledWith({
      storageUserId: 'user-1',
      documentId: 'doc-1',
      keep: { documentVersion: 3, settingsHash: 'current-hash' },
    }, expect.anything());
  });

  test('totals library storage scoped to the session user', async () => {
    mocks.owned = new Set(['kept']);
    mocks.usage.mockResolvedValueOnce({
      documents: [
        { documentId: 'kept', variants: [variant(1, 'a', 100)], exports: [], derivedBytes: 10, derivedObjects: 1 },
        { documentId: 'gone', variants: [variant(1, 'a', 40)], exports: [], derivedBytes: 0, derivedObjects: 0 },
      ],
      scannedObjects: 3,
      truncated: false,
    });
    const response = await libraryUsage(new NextRequest('http://localhost/api/tts/storage'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      audioBytes: 140,
      orphanedAudioBytes: 40,
      orphanedDocumentCount: 1,
      documentDataBytes: 10,
      documentCount: 1,
      truncated: false,
    });
    expect(mocks.usage).toHaveBeenCalledOnce();
    expect(mocks.usage.mock.calls[0][0]).toMatchObject({
      storageUserId: 'user-1', includePlayback: true, derivedDocumentIds: ['kept'],
    });
  });

  test('requires a session for library storage', async () => {
    mocks.authorized = false;
    expect((await libraryUsage(new NextRequest('http://localhost/api/tts/storage'))).status).toBe(401);
    expect((await libraryReclaim(post('/api/tts/storage/reclaim', { target: 'all' }))).status).toBe(401);
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  test('reclaims only orphaned documents in bounded batches', async () => {
    mocks.owned = new Set(['kept']);
    const documents = ['kept', 'a', 'b', 'c', 'd', 'e', 'f'].map((documentId) => ({
      documentId, variants: [variant(1, 'h', 10)], exports: [], derivedBytes: 0, derivedObjects: 0,
    }));
    mocks.usage.mockResolvedValueOnce({ documents, scannedObjects: 7, truncated: false });
    const response = await libraryReclaim(post('/api/tts/storage/reclaim', { target: 'orphaned' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reclaimedDocuments: 5, remainingDocuments: 1, deletedObjects: 15 });
    const reclaimed = mocks.reclaim.mock.calls.map(([input]) => input);
    expect(reclaimed.map((input) => input.documentId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(reclaimed.every((input) => input.keep === null && input.storageUserId === 'user-1')).toBe(true);
  });

  test('rejects unknown library reclaim targets', async () => {
    expect((await libraryReclaim(post('/api/tts/storage/reclaim', { target: 'derived' }))).status).toBe(400);
    expect(mocks.reclaim).not.toHaveBeenCalled();
  });
});

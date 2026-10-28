import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteResults: [] as unknown[][],
  calls: [] as string[],
  deleteDocumentTtsSegmentCache: vi.fn(async () => undefined),
  enqueueStorageCleanup: vi.fn(async (input: { userId: string; documentId: string | null; notBeforeMs?: number }) => {
    mocks.calls.push('enqueue');
    return {
      id: `doc:${input.userId}:${input.documentId}`,
      userId: input.userId,
      documentId: input.documentId,
      notBeforeMs: input.notBeforeMs ?? 1,
      attempts: 0,
    };
  }),
  discardStorageCleanup: vi.fn(async () => undefined),
  runStorageCleanup: vi.fn(async () => 'cleared' as const),
}));

function resultBuilder(result: unknown[]) {
  return {
    then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
}

vi.mock('@openreader/database', () => ({
  db: {
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: () => {
          mocks.calls.push('delete');
          return resultBuilder(mocks.deleteResults.shift() ?? []);
        },
      })),
    })),
  },
}));

vi.mock('@/lib/server/storage/cleanups', () => ({
  enqueueStorageCleanup: mocks.enqueueStorageCleanup,
  discardStorageCleanup: mocks.discardStorageCleanup,
  runStorageCleanup: mocks.runStorageCleanup,
}));

vi.mock('@/lib/server/tts/segments-cache', () => ({
  deleteDocumentTtsSegmentCache: mocks.deleteDocumentTtsSegmentCache,
}));

vi.mock('@/lib/server/logger', () => ({
  hashForLog: () => 'hash',
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/server/errors/logging', () => ({ logDegraded: vi.fn() }));

import { deleteOwnedDocument } from '../../src/lib/server/documents/delete-owned';

describe('owned document cleanup', () => {
  beforeEach(() => {
    mocks.deleteResults = [];
    mocks.calls = [];
    mocks.deleteDocumentTtsSegmentCache.mockReset();
    mocks.deleteDocumentTtsSegmentCache.mockResolvedValue(undefined);
    mocks.enqueueStorageCleanup.mockClear();
    mocks.discardStorageCleanup.mockClear();
    mocks.runStorageCleanup.mockClear();
  });

  test('queues the per-user playback cleanup before the row delete and runs it', async () => {
    mocks.deleteResults = [[{ id: 'doc-1', userId: 'user-1' }]];

    await expect(deleteOwnedDocument({
      userId: 'user-1',
      documentId: 'doc-1',
      namespace: null,
    })).resolves.toBe(true);

    expect(mocks.calls).toEqual(['enqueue', 'delete']);
    // The retry task only takes the row over once the inline run had its chance.
    const [[queuedInput]] = mocks.enqueueStorageCleanup.mock.calls;
    expect(queuedInput).toEqual(expect.objectContaining({ userId: 'user-1', documentId: 'doc-1' }));
    expect(queuedInput.notBeforeMs).toBeGreaterThan(Date.now());
    expect(mocks.runStorageCleanup).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc:user-1:doc-1' }));
    expect(mocks.deleteDocumentTtsSegmentCache).not.toHaveBeenCalled();
  });

  test('discards the queued cleanup and returns false when no row was owned', async () => {
    mocks.deleteResults = [[]];

    await expect(deleteOwnedDocument({
      userId: 'user-1',
      documentId: 'doc-1',
      namespace: null,
    })).resolves.toBe(false);

    expect(mocks.discardStorageCleanup).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc:user-1:doc-1' }));
    expect(mocks.runStorageCleanup).not.toHaveBeenCalled();
  });

  test('cleans a namespaced document inline and still succeeds if that fails', async () => {
    mocks.deleteResults = [[{ id: 'doc-1', userId: 'user-1' }]];
    mocks.deleteDocumentTtsSegmentCache.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(deleteOwnedDocument({
      userId: 'user-1',
      documentId: 'doc-1',
      namespace: 'test-ns',
    })).resolves.toBe(true);

    expect(mocks.enqueueStorageCleanup).not.toHaveBeenCalled();
    expect(mocks.deleteDocumentTtsSegmentCache).toHaveBeenCalledOnce();
  });

  test('can defer the cleanup until after the delete response', async () => {
    mocks.deleteResults = [[{ id: 'doc-1', userId: 'user-1' }]];
    let scheduledCleanup: (() => Promise<void>) | undefined;

    await expect(deleteOwnedDocument({
      userId: 'user-1',
      documentId: 'doc-1',
      namespace: null,
      scheduleCleanup: (task) => {
        scheduledCleanup = task;
      },
    })).resolves.toBe(true);

    expect(mocks.enqueueStorageCleanup).toHaveBeenCalledOnce();
    expect(mocks.runStorageCleanup).not.toHaveBeenCalled();
    await scheduledCleanup?.();
    expect(mocks.runStorageCleanup).toHaveBeenCalledOnce();
  });
});

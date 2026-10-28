import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  deleteWhere: vi.fn(async () => undefined),
  deleteDocumentPreviewRows: vi.fn(async () => undefined),
  isComputeWorkerAvailable: vi.fn(() => true),
  cleanupUserStorage: vi.fn(async () => ({ deletedObjects: 0, deletedDocumentArtifacts: 0 })),
  enqueueStorageCleanup: vi.fn(async () => undefined),
}));

function resultBuilder(result: unknown[]) {
  return {
    then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
}

vi.mock('@openreader/database', () => {
  const database = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => resultBuilder(mocks.selectResults.shift() ?? [])),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => {
        const promise = mocks.deleteWhere();
        return {
          then: promise.then.bind(promise),
          catch: promise.catch.bind(promise),
        };
      }),
    })),
  };
  return { db: database };
});

vi.mock('@/lib/server/storage/s3', () => ({
  isS3Configured: () => true,
  getS3Config: () => ({ prefix: 'openreader-test' }),
}));

vi.mock('@/lib/server/documents/previews', () => ({
  deleteDocumentPreviewRows: mocks.deleteDocumentPreviewRows,
}));

vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: mocks.isComputeWorkerAvailable,
  getComputeWorkerClient: () => ({ cleanupUserStorage: mocks.cleanupUserStorage }),
}));

vi.mock('@/lib/server/storage/cleanups', () => ({
  enqueueStorageCleanup: mocks.enqueueStorageCleanup,
}));

vi.mock('@/lib/server/logger', () => ({
  hashForLog: () => 'hash',
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/server/errors/logging', () => ({
  logDegraded: vi.fn(),
}));

import { deleteUserStorageData } from '../../src/lib/server/user/data-cleanup';

describe('user data cleanup', () => {
  beforeEach(() => {
    mocks.selectResults = [];
    for (const mock of Object.values(mocks)) {
      if (typeof mock === 'function' && 'mockReset' in mock) {
        mock.mockReset();
      }
    }
    mocks.deleteWhere.mockResolvedValue(undefined);
    mocks.deleteDocumentPreviewRows.mockResolvedValue(undefined);
    mocks.isComputeWorkerAvailable.mockReturnValue(true);
    mocks.cleanupUserStorage.mockResolvedValue({ deletedObjects: 0, deletedDocumentArtifacts: 0 });
  });

  test('defers document blobs/previews to the reaper on the canonical pass', async () => {
    await deleteUserStorageData('user-1', null);

    // Shared document storage is reclaimed by the reap-orphaned-blobs task, not here.
    expect(mocks.deleteDocumentPreviewRows).not.toHaveBeenCalled();
    expect(mocks.cleanupUserStorage).toHaveBeenCalledWith({ storageUserId: 'user-1', namespace: null, documentIds: [] });
    // A delayed second pass catches objects a mid-write playback job lands after the sweep.
    expect(mocks.enqueueStorageCleanup).toHaveBeenCalledWith({
      userId: 'user-1',
      documentId: null,
      notBeforeMs: expect.any(Number),
    });
    // Admissions/events cascade with the user; HMAC-keyed buckets and verification are explicit.
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(2);
  });

  test('blocks database cleanup when storage cleanup fails', async () => {
    mocks.cleanupUserStorage.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(deleteUserStorageData('user-1', null)).rejects.toThrow(
      'User storage cleanup failed',
    );
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });

  test('delegates namespaced document storage cleanup to the worker and skips global DB rows', async () => {
    mocks.selectResults = [
      [{ id: 'doc-1' }], // userDocs (namespaced pass)
    ];

    await deleteUserStorageData('user-1', 'test-ns');

    expect(mocks.cleanupUserStorage).toHaveBeenCalledWith({ storageUserId: 'user-1', namespace: 'test-ns', documentIds: ['doc-1'] });
    expect(mocks.deleteDocumentPreviewRows).toHaveBeenCalledWith('doc-1', 'test-ns');
    // Global DB rows are only removed on the canonical pass.
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });
});

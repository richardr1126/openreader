import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteWhere: vi.fn(async () => undefined),
  enqueueStorageCleanup: vi.fn(async () => undefined),
}));

vi.mock('@openreader/database', () => ({
  db: {
    delete: vi.fn(() => ({
      where: vi.fn(() => {
        const promise = mocks.deleteWhere();
        return {
          then: promise.then.bind(promise),
          catch: promise.catch.bind(promise),
        };
      }),
    })),
  },
}));

vi.mock('@/lib/server/storage/s3', () => ({
  isS3Configured: () => true,
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

import { deleteUserDatabaseData } from '../../src/lib/server/user/data-cleanup';

describe('user database cleanup', () => {
  beforeEach(() => {
    mocks.deleteWhere.mockReset();
    mocks.deleteWhere.mockResolvedValue(undefined);
    mocks.enqueueStorageCleanup.mockReset();
  });

  test('queues the delayed storage second pass and removes non-cascading rows', async () => {
    await deleteUserDatabaseData('user-1');

    // A delayed second pass catches objects a mid-write playback job lands after the sweep.
    expect(mocks.enqueueStorageCleanup).toHaveBeenCalledWith({
      userId: 'user-1',
      documentId: null,
      notBeforeMs: expect.any(Number),
    });
    // Admissions/events cascade with the user; HMAC-keyed buckets and verification are explicit.
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(2);
  });

  test('reports a failed row delete so the deletion is retried', async () => {
    mocks.deleteWhere.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(deleteUserDatabaseData('user-1')).rejects.toThrow('User database cleanup failed');
  });
});

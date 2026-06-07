import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  del: vi.fn(async () => undefined),
  owned: [] as Array<{ id: string }>,
  ownedAfterLease: [] as Array<{ id: string }>,
  leaseRelease: vi.fn(async () => undefined),
}));

vi.mock('@/lib/server/storage/s3', () => ({ isS3Configured: () => true }));
vi.mock('@/lib/server/documents/blobstore', () => ({
  listDocumentSourceBlobs: mocks.list,
  deleteDocumentBlob: mocks.del,
}));
vi.mock('@/lib/server/documents/previews-blobstore', () => ({
  deleteDocumentPreviewArtifacts: vi.fn(async () => 0),
}));
vi.mock('@/lib/server/documents/previews', () => ({
  deleteDocumentPreviewRows: vi.fn(async () => undefined),
}));
vi.mock('@/lib/server/documents/blob-lease', () => ({
  tryAcquireDocumentBlobLease: vi.fn(async () => ({
    owner: 'lease-owner',
    release: mocks.leaseRelease,
  })),
}));
vi.mock('@/lib/server/errors/logging', () => ({ logDegraded: vi.fn() }));
vi.mock('@/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = mocks.owned;
          mocks.owned = mocks.ownedAfterLease;
          return Object.assign(Promise.resolve(rows), {
            limit: () => Promise.resolve(rows.slice(0, 1)),
          });
        },
      }),
    }),
  },
}));

import { reapOrphanedBlobs } from '../../src/lib/server/tasks/handlers/reap-orphaned-blobs';

const TWO_HOURS = 2 * 60 * 60 * 1000;
const context = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 });

beforeEach(() => {
  mocks.list.mockReset();
  mocks.del.mockReset();
  mocks.del.mockResolvedValue(undefined);
  mocks.owned = [];
  mocks.ownedAfterLease = [];
  mocks.leaseRelease.mockClear();
});

describe('reap-orphaned-blobs', () => {
  test('reaps only old blobs with no owner', async () => {
    const now = Date.now();
    mocks.list.mockResolvedValue([
      { id: 'orphan-old', lastModifiedMs: now - TWO_HOURS },
      { id: 'owned-old', lastModifiedMs: now - TWO_HOURS },
      { id: 'orphan-young', lastModifiedMs: now - 60_000 },
    ]);
    mocks.owned = [{ id: 'owned-old' }];

    const result = await reapOrphanedBlobs(context());

    expect(mocks.del).toHaveBeenCalledTimes(1);
    expect(mocks.del).toHaveBeenCalledWith('orphan-old', null);
    expect(result.reaped).toBe(1);
    expect(result.scanned).toBe(3);
    expect(result.candidates).toBe(2);
  });

  test('reaps nothing when every old blob still has an owner', async () => {
    const now = Date.now();
    mocks.list.mockResolvedValue([{ id: 'kept', lastModifiedMs: now - TWO_HOURS }]);
    mocks.owned = [{ id: 'kept' }];

    const result = await reapOrphanedBlobs(context());

    expect(mocks.del).not.toHaveBeenCalled();
    expect(result.reaped).toBe(0);
  });

  test('does not delete when an owner appears before the post-lease recheck', async () => {
    const now = Date.now();
    mocks.list.mockResolvedValue([{ id: 'claimed-during-run', lastModifiedMs: now - TWO_HOURS }]);
    mocks.ownedAfterLease = [{ id: 'claimed-during-run' }];

    const result = await reapOrphanedBlobs(context());

    expect(mocks.del).not.toHaveBeenCalled();
    expect(result.reaped).toBe(0);
    expect(mocks.leaseRelease).toHaveBeenCalledTimes(1);
  });

  test('fails the task when an orphan deletion fails', async () => {
    const now = Date.now();
    mocks.list.mockResolvedValue([{ id: 'failed-orphan', lastModifiedMs: now - TWO_HOURS }]);
    mocks.del.mockRejectedValue(new Error('storage failed'));

    await expect(reapOrphanedBlobs(context())).rejects.toThrow('Failed to reap 1');
    expect(mocks.leaseRelease).toHaveBeenCalledTimes(1);
  });
});

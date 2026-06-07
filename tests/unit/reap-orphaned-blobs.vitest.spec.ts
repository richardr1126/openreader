import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  del: vi.fn(async () => undefined),
  owned: [] as Array<{ id: string }>,
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
vi.mock('@/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve(mocks.owned) }) }),
  },
}));

import { reapOrphanedBlobs } from '../../src/lib/server/tasks/handlers/reap-orphaned-blobs';

const TWO_HOURS = 2 * 60 * 60 * 1000;

beforeEach(() => {
  mocks.list.mockReset();
  mocks.del.mockReset();
  mocks.del.mockResolvedValue(undefined);
  mocks.owned = [];
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

    const result = await reapOrphanedBlobs();

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

    const result = await reapOrphanedBlobs();

    expect(mocks.del).not.toHaveBeenCalled();
    expect(result.reaped).toBe(0);
  });
});

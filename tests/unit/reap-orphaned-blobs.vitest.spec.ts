import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  del: vi.fn(async () => undefined),
  clearPdfLayout: vi.fn(async () => ({ deletedParsedObjects: 0 })),
  clearPreviews: vi.fn(async () => ({ deletedPreviewObjects: 0 })),
  clearPlans: vi.fn(async () => ({ deletedPlanObjects: 0 })),
  listDerived: vi.fn(async () => ({ documentIds: [] as string[] })),
  deletePreviewRows: vi.fn(async () => undefined),
  owned: [] as Array<{ id: string }>,
  ownedAfterLease: [] as Array<{ id: string }>,
  leaseRelease: vi.fn(async () => undefined),
}));

vi.mock('@/lib/server/storage/s3', () => ({ isS3Configured: () => true }));
vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: () => true,
  getComputeWorkerClient: () => ({
    clearPdfLayoutArtifacts: mocks.clearPdfLayout,
    clearDocumentPreviewArtifacts: mocks.clearPreviews,
    clearTtsPlaybackPlans: mocks.clearPlans,
    listDocumentDerivedIds: mocks.listDerived,
  }),
}));
vi.mock('@/lib/server/documents/blobstore', () => ({
  listDocumentSourceBlobs: mocks.list,
  deleteDocumentBlob: mocks.del,
}));
vi.mock('@/lib/server/documents/previews', () => ({
  deleteDocumentPreviewRows: mocks.deletePreviewRows,
}));
vi.mock('@/lib/server/documents/blob-lease', () => ({
  tryAcquireDocumentBlobLease: vi.fn(async () => ({
    owner: 'lease-owner',
    release: mocks.leaseRelease,
  })),
}));
vi.mock('@/lib/server/errors/logging', () => ({ logDegraded: vi.fn() }));
vi.mock('@openreader/database', () => ({
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
const context = () => ({ signal: new AbortController().signal, deadlineAt: Date.now() + 60_000, cursor: null });

beforeEach(() => {
  mocks.list.mockReset();
  mocks.del.mockReset();
  mocks.del.mockResolvedValue(undefined);
  mocks.clearPdfLayout.mockClear();
  mocks.clearPreviews.mockClear();
  mocks.clearPlans.mockClear();
  mocks.listDerived.mockReset();
  mocks.listDerived.mockResolvedValue({ documentIds: [] });
  mocks.deletePreviewRows.mockClear();
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
    expect(mocks.clearPdfLayout).toHaveBeenCalledWith(
      { documentId: 'orphan-old', namespace: null },
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.clearPreviews).toHaveBeenCalledWith(
      { documentId: 'orphan-old', namespace: null },
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.clearPlans).toHaveBeenCalledWith(
      { documentId: 'orphan-old' },
      { signal: expect.any(AbortSignal) },
    );
    // The source blob goes last so a failed earlier step keeps the document a candidate.
    for (const clear of [mocks.clearPdfLayout, mocks.clearPreviews, mocks.clearPlans, mocks.deletePreviewRows]) {
      expect(clear.mock.invocationCallOrder[0]).toBeLessThan(mocks.del.mock.invocationCallOrder[0]);
    }
    expect(result.reaped).toBe(1);
    expect(result.scanned).toBe(3);
    expect(result.candidates).toBe(2);
  });

  test('reaps derived artifacts whose source blob is already gone', async () => {
    const now = Date.now();
    mocks.list.mockResolvedValue([{ id: 'uploading', lastModifiedMs: now - 60_000 }]);
    mocks.listDerived.mockResolvedValue({ documentIds: ['derived-only', 'uploading'] });

    const result = await reapOrphanedBlobs(context());

    expect(mocks.clearPreviews).toHaveBeenCalledTimes(1);
    expect(mocks.clearPreviews).toHaveBeenCalledWith(
      { documentId: 'derived-only', namespace: null },
      { signal: expect.any(AbortSignal) },
    );
    expect(mocks.deletePreviewRows).toHaveBeenCalledWith('derived-only', null);
    expect(mocks.del).not.toHaveBeenCalled();
    expect(result.reaped).toBe(1);
  });

  test('keeps derived artifacts when preview rows cannot be deleted, so the next run retries', async () => {
    mocks.list.mockResolvedValue([]);
    mocks.listDerived.mockResolvedValue({ documentIds: ['derived-only'] });
    mocks.deletePreviewRows.mockRejectedValueOnce(new Error('db unavailable'));

    await expect(reapOrphanedBlobs(context())).rejects.toThrow('Failed to reap 1 orphaned blob(s)');

    expect(mocks.clearPdfLayout).not.toHaveBeenCalled();
    expect(mocks.clearPreviews).not.toHaveBeenCalled();
    expect(mocks.clearPlans).not.toHaveBeenCalled();
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

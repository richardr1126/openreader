import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  deleteResults: [] as unknown[][],
  insertValues: vi.fn(() => ({ onConflictDoNothing: vi.fn(async () => undefined) })),
  deleteDocumentBlob: vi.fn(async () => undefined),
  cleanupDocumentPreviewArtifacts: vi.fn(async () => undefined),
  deleteDocumentPreviewRows: vi.fn(async () => undefined),
  deleteDocumentTtsSegmentCache: vi.fn(async () => undefined),
}));

function resultBuilder(result: unknown[]) {
  const limited = {
    all: () => result,
    then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return {
    all: () => result,
    limit: () => limited,
    then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
}

vi.mock('@/db', () => {
  const database = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => resultBuilder(mocks.selectResults.shift() ?? [])),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: () => resultBuilder(mocks.deleteResults.shift() ?? []),
      })),
    })),
    insert: vi.fn(() => ({
      values: mocks.insertValues,
    })),
    transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(database)),
  };
  return { db: database };
});

vi.mock('@/lib/server/documents/blobstore', () => ({
  deleteDocumentBlob: mocks.deleteDocumentBlob,
}));

vi.mock('@/lib/server/documents/previews', () => ({
  cleanupDocumentPreviewArtifacts: mocks.cleanupDocumentPreviewArtifacts,
  deleteDocumentPreviewRows: mocks.deleteDocumentPreviewRows,
}));

vi.mock('@/lib/server/tts/segments-cache', () => ({
  deleteDocumentTtsSegmentCache: mocks.deleteDocumentTtsSegmentCache,
}));

import { deleteOwnedDocument } from '../../src/lib/server/documents/delete-owned';

describe('owned document cleanup', () => {
  beforeEach(() => {
    mocks.selectResults = [];
    mocks.deleteResults = [];
    mocks.insertValues.mockReset();
    mocks.insertValues.mockReturnValue({ onConflictDoNothing: vi.fn(async () => undefined) });
    mocks.deleteDocumentBlob.mockReset();
    mocks.deleteDocumentBlob.mockResolvedValue(undefined);
    mocks.cleanupDocumentPreviewArtifacts.mockReset();
    mocks.cleanupDocumentPreviewArtifacts.mockResolvedValue(undefined);
    mocks.deleteDocumentPreviewRows.mockReset();
    mocks.deleteDocumentPreviewRows.mockResolvedValue(undefined);
    mocks.deleteDocumentTtsSegmentCache.mockReset();
    mocks.deleteDocumentTtsSegmentCache.mockResolvedValue(undefined);
  });

  test('deletes only user-scoped TTS when another owner remains', async () => {
    mocks.deleteResults = [[{ id: 'doc-1', userId: 'user-1' }]];
    mocks.selectResults = [[{ id: 'doc-1' }]];

    await expect(deleteOwnedDocument({
      userId: 'user-1',
      documentId: 'doc-1',
      namespace: null,
    })).resolves.toBe(true);

    expect(mocks.deleteDocumentTtsSegmentCache).toHaveBeenCalledOnce();
    expect(mocks.deleteDocumentBlob).not.toHaveBeenCalled();
    expect(mocks.cleanupDocumentPreviewArtifacts).not.toHaveBeenCalled();
  });

  test('deletes shared artifacts only for the final owner', async () => {
    mocks.deleteResults = [[{ id: 'doc-1', userId: 'user-1' }]];
    mocks.selectResults = [[], []];

    await deleteOwnedDocument({
      userId: 'user-1',
      documentId: 'doc-1',
      namespace: null,
    });

    expect(mocks.cleanupDocumentPreviewArtifacts).toHaveBeenCalledWith('doc-1', null);
    expect(mocks.deleteDocumentPreviewRows).toHaveBeenCalledWith('doc-1', null);
    expect(mocks.deleteDocumentBlob).toHaveBeenCalledWith('doc-1', null);
  });

  test('restores ownership when cleanup fails', async () => {
    const removed = { id: 'doc-1', userId: 'user-1' };
    mocks.deleteResults = [[removed]];
    mocks.selectResults = [[], []];
    mocks.deleteDocumentBlob.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(deleteOwnedDocument({
      userId: 'user-1',
      documentId: 'doc-1',
      namespace: null,
    })).rejects.toThrow('storage unavailable');

    expect(mocks.insertValues).toHaveBeenCalledWith(removed);
  });

  test('keeps shared artifacts when a new owner appears before deletion', async () => {
    mocks.deleteResults = [[{ id: 'doc-1', userId: 'user-1' }]];
    mocks.selectResults = [[], [{ id: 'doc-1' }]];

    await deleteOwnedDocument({
      userId: 'user-1',
      documentId: 'doc-1',
      namespace: null,
    });

    expect(mocks.deleteDocumentBlob).not.toHaveBeenCalled();
  });
});

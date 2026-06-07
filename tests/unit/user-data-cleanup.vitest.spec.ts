import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  deleteWhere: vi.fn(async () => undefined),
  deleteDocumentBlob: vi.fn(async () => undefined),
  deleteDocumentPrefix: vi.fn(async () => 0),
  deleteDocumentPreviewArtifacts: vi.fn(async () => 0),
  deleteDocumentPreviewRows: vi.fn(async () => undefined),
  deleteAudiobookPrefix: vi.fn(async () => 0),
  deleteTtsSegmentPrefix: vi.fn(async () => 0),
}));

function resultBuilder(result: unknown[]) {
  return {
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

vi.mock('@/lib/server/documents/blobstore', () => ({
  deleteDocumentBlob: mocks.deleteDocumentBlob,
  deleteDocumentPrefix: mocks.deleteDocumentPrefix,
  tempDocumentUploadPrefix: () => 'temp/user/',
}));

vi.mock('@/lib/server/documents/previews-blobstore', () => ({
  deleteDocumentPreviewArtifacts: mocks.deleteDocumentPreviewArtifacts,
}));

vi.mock('@/lib/server/documents/previews', () => ({
  deleteDocumentPreviewRows: mocks.deleteDocumentPreviewRows,
}));

vi.mock('@/lib/server/audiobooks/blobstore', () => ({
  audiobookPrefix: () => 'audiobooks/user/',
  deleteAudiobookPrefix: mocks.deleteAudiobookPrefix,
}));

vi.mock('@/lib/server/tts/segments-blobstore', () => ({
  deleteTtsSegmentPrefix: mocks.deleteTtsSegmentPrefix,
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
    mocks.deleteDocumentBlob.mockResolvedValue(undefined);
    mocks.deleteDocumentPrefix.mockResolvedValue(0);
    mocks.deleteDocumentPreviewArtifacts.mockResolvedValue(0);
    mocks.deleteDocumentPreviewRows.mockResolvedValue(undefined);
    mocks.deleteAudiobookPrefix.mockResolvedValue(0);
    mocks.deleteTtsSegmentPrefix.mockResolvedValue(0);
  });

  test('defers document blobs/previews to the reaper on the canonical pass', async () => {
    mocks.selectResults = [[]]; // no audiobooks

    await deleteUserStorageData('user-1', null);

    // Shared document storage is reclaimed by the reap-orphaned-blobs task, not here.
    expect(mocks.deleteDocumentBlob).not.toHaveBeenCalled();
    expect(mocks.deleteDocumentPreviewArtifacts).not.toHaveBeenCalled();
    expect(mocks.deleteDocumentPreviewRows).not.toHaveBeenCalled();
    // Only the three non-cascading DB row deletes (tts usage, job events, verification).
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(3);
  });

  test('blocks database cleanup when storage cleanup fails', async () => {
    mocks.selectResults = [[]]; // no audiobooks
    mocks.deleteDocumentPrefix.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(deleteUserStorageData('user-1', null)).rejects.toThrow(
      'User storage cleanup failed',
    );
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });

  test('deletes namespaced document storage inline and skips global DB rows', async () => {
    mocks.selectResults = [
      [{ id: 'doc-1' }], // userDocs (namespaced pass)
      [], // audiobooks
    ];

    await deleteUserStorageData('user-1', 'test-ns');

    expect(mocks.deleteDocumentBlob).toHaveBeenCalledWith('doc-1', 'test-ns');
    expect(mocks.deleteDocumentPreviewArtifacts).toHaveBeenCalledWith('doc-1', 'test-ns');
    expect(mocks.deleteDocumentPreviewRows).toHaveBeenCalledWith('doc-1', 'test-ns');
    // Global DB rows are only removed on the canonical pass.
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });
});

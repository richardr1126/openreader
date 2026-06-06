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
    limit: async () => result,
    then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
}

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => resultBuilder(mocks.selectResults.shift() ?? [])),
      })),
    })),
    delete: vi.fn(() => ({
      where: mocks.deleteWhere,
    })),
  },
}));

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

  test('keeps shared document blobs and previews', async () => {
    mocks.selectResults = [
      [{ id: 'shared-doc' }],
      [{ id: 'shared-doc' }],
      [],
    ];

    await deleteUserStorageData('user-1', null);

    expect(mocks.deleteDocumentBlob).not.toHaveBeenCalled();
    expect(mocks.deleteDocumentPreviewArtifacts).not.toHaveBeenCalled();
    expect(mocks.deleteDocumentPreviewRows).not.toHaveBeenCalled();
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(3);
  });

  test('blocks database cleanup when storage cleanup fails', async () => {
    mocks.selectResults = [[], []];
    mocks.deleteDocumentPrefix.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(deleteUserStorageData('user-1', null)).rejects.toThrow(
      'User storage cleanup failed',
    );
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });
});

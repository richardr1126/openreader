import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  documentDeleteResults: [] as unknown[][],
  deleteWhere: vi.fn(async () => undefined),
  insertValues: vi.fn(() => ({ onConflictDoNothing: vi.fn(async () => undefined) })),
  forUpdate: vi.fn(),
  deleteDocumentBlob: vi.fn(async () => undefined),
  deleteDocumentPrefix: vi.fn(async () => 0),
  deleteDocumentPreviewArtifacts: vi.fn(async () => 0),
  deleteDocumentPreviewRows: vi.fn(async () => undefined),
  deleteAudiobookPrefix: vi.fn(async () => 0),
  deleteTtsSegmentPrefix: vi.fn(async () => 0),
}));

function resultBuilder(result: unknown[]) {
  const limitedResult = {
    all: () => result,
    then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return {
    all: () => result,
    for: vi.fn((mode: string) => {
      mocks.forUpdate(mode);
      return Promise.resolve(result);
    }),
    limit: () => limitedResult,
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
          returning: () => resultBuilder(mocks.documentDeleteResults.shift() ?? []),
        };
      }),
    })),
    insert: vi.fn(() => ({
      values: mocks.insertValues,
    })),
    execute: vi.fn(async () => undefined),
    transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(database)),
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mocks.selectResults = [];
    mocks.documentDeleteResults = [];
    for (const mock of Object.values(mocks)) {
      if (typeof mock === 'function' && 'mockReset' in mock) {
        mock.mockReset();
      }
    }
    mocks.deleteWhere.mockResolvedValue(undefined);
    mocks.insertValues.mockReturnValue({ onConflictDoNothing: vi.fn(async () => undefined) });
    mocks.forUpdate.mockReset();
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
    mocks.documentDeleteResults = [[{ id: 'shared-doc' }]];

    await deleteUserStorageData('user-1', null);

    expect(mocks.deleteDocumentBlob).not.toHaveBeenCalled();
    expect(mocks.deleteDocumentPreviewArtifacts).not.toHaveBeenCalled();
    expect(mocks.deleteDocumentPreviewRows).not.toHaveBeenCalled();
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(4);
  });

  test('blocks database cleanup when storage cleanup fails', async () => {
    mocks.selectResults = [[], []];
    mocks.deleteDocumentPrefix.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(deleteUserStorageData('user-1', null)).rejects.toThrow(
      'User storage cleanup failed',
    );
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });

  test('restores document ownership when document storage cleanup fails', async () => {
    mocks.selectResults = [
      [{ id: 'doc-1' }],
      [],
      [],
    ];
    mocks.documentDeleteResults = [[{ id: 'doc-1' }]];
    mocks.deleteDocumentBlob.mockRejectedValueOnce(new Error('storage unavailable'));

    await expect(deleteUserStorageData('user-1', null)).rejects.toThrow(
      'User storage cleanup failed',
    );

    expect(mocks.insertValues).toHaveBeenCalledWith([{ id: 'doc-1' }]);
  });

  test('does not delete global preview rows during namespaced cleanup', async () => {
    mocks.selectResults = [
      [{ id: 'doc-1' }],
      [],
      [],
    ];
    mocks.documentDeleteResults = [[{ id: 'doc-1' }]];

    await deleteUserStorageData('user-1', 'test-ns');

    expect(mocks.deleteDocumentPreviewRows).not.toHaveBeenCalled();
    expect(mocks.insertValues).toHaveBeenCalledWith([{ id: 'doc-1' }]);
  });

  test('locks all document owners before the Postgres ownership decision', async () => {
    vi.stubEnv('POSTGRES_URL', 'postgres://test');
    mocks.selectResults = [
      [{ id: 'doc-1' }],
      [{ id: 'doc-1' }],
      [],
      [],
    ];
    mocks.documentDeleteResults = [[{ id: 'doc-1' }]];

    await deleteUserStorageData('user-1', null);

    expect(mocks.forUpdate).toHaveBeenCalledWith('update');
  });
});

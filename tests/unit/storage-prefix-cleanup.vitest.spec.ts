import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock('@/lib/server/storage/s3', () => ({
  getS3Config: () => ({ bucket: 'test-bucket', prefix: 'openreader-test' }),
  getS3Client: () => ({ send: mocks.send }),
  getS3ProxyClient: () => ({ send: mocks.send }),
}));

import { deleteAudiobookPrefix } from '../../src/lib/server/audiobooks/blobstore';
import {
  deleteAllExpiredTempDocumentUploads,
  deleteDocumentBlob,
  deleteDocumentPrefix,
} from '../../src/lib/server/documents/blobstore';

describe('storage prefix cleanup', () => {
  beforeEach(() => {
    mocks.send.mockReset();
  });

  test.each([
    ['document', deleteDocumentPrefix],
    ['audiobook', deleteAudiobookPrefix],
  ])('%s cleanup counts successful quiet deletes', async (_name, removePrefix) => {
    mocks.send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'prefix/a' }, { Key: 'prefix/b' }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({});

    await expect(removePrefix('prefix/')).resolves.toBe(2);
  });

  test.each([
    ['document', deleteDocumentPrefix],
    ['audiobook', deleteAudiobookPrefix],
  ])('%s cleanup fails on per-object storage errors', async (_name, removePrefix) => {
    mocks.send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'prefix/a' }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Errors: [{ Key: 'prefix/a', Code: 'AccessDenied' }],
      });

    await expect(removePrefix('prefix/')).rejects.toThrow('Failed deleting 1');
  });

  test('deletes the source after derived artifacts and then sweeps late parsed output', async () => {
    mocks.send
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false })
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Contents: [], IsTruncated: false });

    const documentId = 'a'.repeat(64);
    await deleteDocumentBlob(documentId, null);

    const commands = mocks.send.mock.calls.map(([command]) => command);
    const sourceDeleteIndex = commands.findIndex((command) =>
      command.constructor.name === 'DeleteObjectCommand'
      && command.input.Key === `openreader-test/documents_v1/${documentId}`);
    const finalCommand = commands.at(-1);

    expect(sourceDeleteIndex).toBeGreaterThan(1);
    expect(finalCommand?.constructor.name).toBe('ListObjectsV2Command');
    expect(finalCommand?.input.Prefix).toBe(
      `openreader-test/documents_v1/parsed_v2/${documentId}/`,
    );
  });

  test('keeps the source document when derived-artifact cleanup fails', async () => {
    mocks.send.mockRejectedValueOnce(new Error('list failed'));

    const documentId = 'b'.repeat(64);
    await expect(deleteDocumentBlob(documentId, null)).rejects.toThrow('list failed');

    const sourceDelete = mocks.send.mock.calls
      .map(([command]) => command)
      .find((command) => command.constructor.name === 'DeleteObjectCommand'
        && command.input.Key === `openreader-test/documents_v1/${documentId}`);
    expect(sourceDelete).toBeUndefined();
  });

  test('deletes expired temporary uploads page by page', async () => {
    const old = new Date(Date.now() - 60_000);
    mocks.send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'temp/a', LastModified: old }],
        IsTruncated: true,
        NextContinuationToken: 'next',
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        Contents: [{ Key: 'temp/b', LastModified: old }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({});

    await expect(deleteAllExpiredTempDocumentUploads(null, Date.now())).resolves.toBe(2);

    expect(mocks.send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
      'ListObjectsV2Command',
      'DeleteObjectsCommand',
      'ListObjectsV2Command',
      'DeleteObjectsCommand',
    ]);
  });

  test('temporary upload cleanup fails on per-object storage errors', async () => {
    const old = new Date(Date.now() - 60_000);
    mocks.send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'temp/a', LastModified: old }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Errors: [{ Key: 'temp/a', Code: 'AccessDenied' }],
      });

    await expect(deleteAllExpiredTempDocumentUploads(null, Date.now()))
      .rejects.toThrow('test-bucket');
  });
});

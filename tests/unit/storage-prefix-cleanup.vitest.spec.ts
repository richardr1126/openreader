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
import { deleteDocumentPrefix } from '../../src/lib/server/documents/blobstore';

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
});

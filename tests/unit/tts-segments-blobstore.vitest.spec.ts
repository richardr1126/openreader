import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock('@/lib/server/storage/s3', () => ({
  getS3Config: () => ({ bucket: 'test-bucket' }),
  getS3Client: () => ({ send: mocks.send }),
  getS3ProxyClient: () => ({ send: mocks.send }),
}));

import { deleteTtsSegmentPrefix } from '../../src/lib/server/tts/segments-blobstore';

describe('TTS segment blob cleanup', () => {
  beforeEach(() => {
    mocks.send.mockReset();
  });

  test('counts successful quiet deletes by requested object count', async () => {
    mocks.send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'prefix/a.mp3' }, { Key: 'prefix/b.mp3' }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({});

    await expect(deleteTtsSegmentPrefix('prefix/')).resolves.toBe(2);
  });

  test('fails cleanup when storage reports per-object deletion errors', async () => {
    mocks.send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'prefix/a.mp3' }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({
        Errors: [{ Key: 'prefix/a.mp3', Code: 'AccessDenied' }],
      });

    await expect(deleteTtsSegmentPrefix('prefix/')).rejects.toThrow(
      'Failed deleting 1 TTS segment audio objects',
    );
  });
});

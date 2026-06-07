import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
}));

vi.mock('@/lib/server/storage/s3', () => ({
  getS3Config: () => ({ bucket: 'test-bucket' }),
  getS3Client: () => ({ send: mocks.send }),
  getS3ProxyClient: () => ({ send: mocks.send }),
}));

import { copyTtsSegmentPrefix, deleteTtsSegmentPrefix } from '../../src/lib/server/tts/segments-blobstore';

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

  test('copies a user-scoped prefix without deleting its source objects', async () => {
    mocks.send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'source/doc/audio.mp3' }],
        IsTruncated: false,
      })
      .mockResolvedValueOnce({});

    await expect(copyTtsSegmentPrefix('source/doc/', 'destination/doc/')).resolves.toBe(1);

    const copyCommand = mocks.send.mock.calls[1]?.[0];
    expect(copyCommand.constructor.name).toBe('CopyObjectCommand');
    expect(copyCommand.input).toMatchObject({
      Key: 'destination/doc/audio.mp3',
      CopySource: 'test-bucket/source/doc/audio.mp3',
    });
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  test('does not delete source objects when a TTS prefix copy fails', async () => {
    mocks.send
      .mockResolvedValueOnce({
        Contents: [{ Key: 'source/doc/audio.mp3' }],
        IsTruncated: false,
      })
      .mockRejectedValueOnce(new Error('copy failed'));

    await expect(copyTtsSegmentPrefix('source/doc/', 'destination/doc/')).rejects.toThrow('copy failed');
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
});

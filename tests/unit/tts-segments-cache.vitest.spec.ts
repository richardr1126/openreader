import { createHash } from 'crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteTtsSegmentPrefix: vi.fn(async () => 0),
}));

vi.mock('@/lib/server/tts/segments-blobstore', () => ({
  deleteTtsSegmentPrefix: mocks.deleteTtsSegmentPrefix,
}));

vi.mock('@/lib/server/storage/s3', () => ({
  getS3Config: () => ({ prefix: 'openreader-test' }),
}));

vi.mock('@/lib/server/logger', () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/server/errors/logging', () => ({
  logDegraded: vi.fn(),
}));

import { clearTtsSegmentCache } from '../../src/lib/server/tts/segments-cache';

describe('TTS segment cache cleanup', () => {
  beforeEach(() => {
    mocks.deleteTtsSegmentPrefix.mockReset();
    mocks.deleteTtsSegmentPrefix.mockResolvedValue(2);
  });

  test('deletes legacy and playback artifact prefixes', async () => {
    const result = await clearTtsSegmentCache({
      userId: 'user-1',
      documentId: 'doc-1',
      documentVersion: 3,
    });

    expect(result).toMatchObject({
      deletedSegments: 0,
      requestedAudioObjects: 6,
      deletedAudioObjects: 6,
      invalidatedPlaybackSessions: 0,
    });
    const userHash = createHash('sha256').update('user-1').digest('hex');
    expect(mocks.deleteTtsSegmentPrefix).toHaveBeenCalledWith('openreader-test/tts_segments_v1/users/user-1/docs/doc-1/');
    expect(mocks.deleteTtsSegmentPrefix).toHaveBeenCalledWith('openreader-test/tts_segments_v2/users/user-1/docs/doc-1/');
    expect(mocks.deleteTtsSegmentPrefix).toHaveBeenCalledWith(`openreader-test/tts_playback_segments_v1/users/${userHash}/docs/doc-1/3/`);
  });
});

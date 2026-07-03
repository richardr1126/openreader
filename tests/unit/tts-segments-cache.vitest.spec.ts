import { createHash } from 'crypto';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteTtsSegmentPrefix: vi.fn(async () => 0),
  s3Send: vi.fn(async (_command?: unknown): Promise<unknown> => ({ Contents: [] })),
  isComputeWorkerAvailable: vi.fn(() => false),
  resetTtsPlaybackScope: vi.fn(async () => ({
    storageUserId: 'user-1',
    documentId: 'doc-1',
    documentVersion: 3,
    settingsHash: null,
    cacheEpoch: 1,
    invalidatedPlaybackSessions: 0,
    invalidatedSidecarCacheScopes: 0,
    invalidatedJobOperations: 0,
  })),
}));

vi.mock('@/lib/server/tts/segments-blobstore', () => ({
  deleteTtsSegmentPrefix: mocks.deleteTtsSegmentPrefix,
}));

vi.mock('@/lib/server/storage/s3', () => ({
  getS3Config: () => ({ bucket: 'bucket', prefix: 'openreader-test' }),
  getS3ProxyClient: () => ({ send: mocks.s3Send }),
}));

vi.mock('@/lib/server/logger', () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/server/errors/logging', () => ({
  logDegraded: vi.fn(),
}));

vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: mocks.isComputeWorkerAvailable,
  getComputeWorkerClient: () => ({
    resetTtsPlaybackScope: mocks.resetTtsPlaybackScope,
  }),
}));

import { clearTtsSegmentCache } from '../../src/lib/server/tts/segments-cache';

describe('TTS segment cache cleanup', () => {
  beforeEach(() => {
    mocks.deleteTtsSegmentPrefix.mockReset();
    mocks.deleteTtsSegmentPrefix.mockResolvedValue(2);
    mocks.s3Send.mockReset();
    mocks.s3Send.mockResolvedValue({ Contents: [] });
    mocks.isComputeWorkerAvailable.mockReset();
    mocks.isComputeWorkerAvailable.mockReturnValue(false);
    mocks.resetTtsPlaybackScope.mockClear();
    mocks.resetTtsPlaybackScope.mockResolvedValue({
      storageUserId: 'user-1',
      documentId: 'doc-1',
      documentVersion: 3,
      settingsHash: null,
      cacheEpoch: 1,
      invalidatedPlaybackSessions: 0,
      invalidatedSidecarCacheScopes: 0,
      invalidatedJobOperations: 0,
    });
  });

  test('deletes playback audio, sidecar, and plan prefixes', async () => {
    const result = await clearTtsSegmentCache({
      userId: 'user-1',
      documentId: 'doc-1',
      documentVersion: 3,
      readerType: 'pdf',
    });

    expect(result).toMatchObject({
      deletedSegments: 0,
      requestedAudioObjects: 4,
      deletedAudioObjects: 4,
      deletedPlanObjects: 2,
      deletedPlaybackObjects: 6,
      invalidatedPlaybackSessions: 0,
    });
    const userHash = createHash('sha256').update('user-1').digest('hex');
    expect(mocks.deleteTtsSegmentPrefix).toHaveBeenCalledWith('openreader-test/tts_playback_segments_audio_v1/users/user-1/docs/doc-1/3/');
    expect(mocks.deleteTtsSegmentPrefix).toHaveBeenCalledWith(`openreader-test/tts_playback_segments_v1/users/${userHash}/docs/doc-1/3/`);
    expect(mocks.deleteTtsSegmentPrefix).toHaveBeenCalledWith('openreader-test/tts_playback_plan_v1/doc-1/3/pdf/');
  });

  test('resets worker playback scope before deleting cache objects', async () => {
    mocks.isComputeWorkerAvailable.mockReturnValue(true);
    mocks.resetTtsPlaybackScope.mockResolvedValue({
      storageUserId: 'user-1',
      documentId: 'doc-1',
      documentVersion: 3,
      settingsHash: null,
      cacheEpoch: 4,
      invalidatedPlaybackSessions: 2,
      invalidatedSidecarCacheScopes: 1,
      invalidatedJobOperations: 3,
    });

    const result = await clearTtsSegmentCache({
      userId: 'user-1',
      documentId: 'doc-1',
      documentVersion: 3,
    });

    expect(mocks.resetTtsPlaybackScope).toHaveBeenCalledWith({
      storageUserId: 'user-1',
      documentId: 'doc-1',
      documentVersion: 3,
    });
    expect(result.invalidatedPlaybackSessions).toBe(2);
    expect(result.invalidatedJobOperations).toBe(3);
    expect(mocks.resetTtsPlaybackScope.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteTtsSegmentPrefix.mock.invocationCallOrder[0],
    );
  });

  test('deletes worker export artifacts whose metadata matches the cleared scope', async () => {
    mocks.s3Send.mockImplementation(async (rawCommand: unknown) => {
      const command = rawCommand as { input?: Record<string, unknown>; constructor?: { name?: string } };
      if (command.constructor?.name === 'ListObjectsV2Command') {
        return {
          Contents: [
            { Key: 'openreader-test/tts_playback_exports_v1/artifact-a/metadata.json' },
            { Key: 'openreader-test/tts_playback_exports_v1/artifact-b/metadata.json' },
          ],
        };
      }
      if (command.constructor?.name === 'GetObjectCommand') {
        const key = command.input?.Key;
        return {
          Body: {
            transformToByteArray: async () => Buffer.from(JSON.stringify({
              storageUserId: key === 'openreader-test/tts_playback_exports_v1/artifact-a/metadata.json' ? 'user-1' : 'other-user',
              documentId: 'doc-1',
              documentVersion: 3,
            })),
          },
        };
      }
      return {};
    });

    const result = await clearTtsSegmentCache({
      userId: 'user-1',
      documentId: 'doc-1',
      documentVersion: 3,
      readerType: 'pdf',
    });

    expect(mocks.deleteTtsSegmentPrefix).toHaveBeenCalledWith('openreader-test/tts_playback_exports_v1/artifact-a/');
    expect(mocks.deleteTtsSegmentPrefix).not.toHaveBeenCalledWith('openreader-test/tts_playback_exports_v1/artifact-b/');
    expect(result.deletedExportObjects).toBe(2);
    expect(result.deletedPlaybackObjects).toBe(8);
  });
});

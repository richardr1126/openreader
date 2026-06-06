import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  deleteWhere: vi.fn(async () => undefined),
  deleteTtsSegmentAudioObjects: vi.fn(async () => 0),
}));

function resultBuilder(result: unknown[]) {
  return {
    innerJoin: vi.fn(() => ({
      where: vi.fn(async () => result),
    })),
    where: vi.fn(async () => result),
  };
}

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => resultBuilder(mocks.selectResults.shift() ?? [])),
    })),
    delete: vi.fn(() => ({
      where: mocks.deleteWhere,
    })),
  },
}));

vi.mock('@/lib/server/tts/segments-blobstore', () => ({
  deleteTtsSegmentAudioObjects: mocks.deleteTtsSegmentAudioObjects,
  deleteTtsSegmentPrefix: vi.fn(async () => 0),
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
    mocks.selectResults = [];
    mocks.deleteWhere.mockReset();
    mocks.deleteWhere.mockResolvedValue(undefined);
    mocks.deleteTtsSegmentAudioObjects.mockReset();
    mocks.deleteTtsSegmentAudioObjects.mockResolvedValue(2);
  });

  test('counts deleted entries rather than joined variants', async () => {
    mocks.selectResults = [
      [{ segmentEntryId: 'entry-1' }, { segmentEntryId: 'entry-2' }],
      [
        { segmentId: 'variant-1', audioKey: 'audio-1' },
        { segmentId: 'variant-2', audioKey: 'audio-2' },
        { segmentId: 'variant-3', audioKey: 'audio-2' },
      ],
    ];

    const result = await clearTtsSegmentCache({
      userId: 'user-1',
      documentId: 'doc-1',
    });

    expect(result).toMatchObject({
      deletedSegments: 2,
      requestedAudioObjects: 2,
      deletedAudioObjects: 2,
    });
  });
});

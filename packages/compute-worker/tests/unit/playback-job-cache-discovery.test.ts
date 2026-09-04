import { describe, expect, test, vi } from 'vitest';
import { createTtsPlaybackHandler } from '../../src/jobs/playback/playback-job';
import { resolveAndPersistTtsPlaybackPlan } from '../../src/jobs/playback/plan';
import { generateExplicitTtsPlaybackSegments } from '../../src/jobs/playback/segment-generation';

vi.mock('../../src/jobs/playback/plan', () => ({ resolveAndPersistTtsPlaybackPlan: vi.fn() }));
vi.mock('../../src/jobs/playback/segment-generation', () => ({ generateExplicitTtsPlaybackSegments: vi.fn() }));

describe('playback job cache discovery', () => {
  test('starts a sparse long book without probing every ungenerated segment', async () => {
    const plannedSegments = Array.from({ length: 10_000 }, (_, ordinal) => ({ ordinal, text: 'A sentence.' }));
    vi.mocked(resolveAndPersistTtsPlaybackPlan).mockResolvedValue({
      planObjectKey: 'plan', plannedSegments, startOrdinal: 8_000,
    } as never);
    const session = {
      sessionId: 'session', status: 'running', generationRunId: 'run', playbackActive: true,
      cursorOrdinal: 8_000, generationStartOrdinal: 8_000, expiresAt: Date.now() + 60_000,
    };
    const sidecars = new Map([
      [2, { ordinal: 2, status: 'completed', audioKey: 'audio/2', cacheEpoch: 3 }],
      [7, { ordinal: 7, status: 'completed', audioKey: 'old/7', cacheEpoch: 2 }],
      [8_000, { ordinal: 8_000, status: 'generating', cacheEpoch: 3 }],
      [20_000, { ordinal: 20_000, status: 'completed', audioKey: 'outside-plan', cacheEpoch: 3 }],
    ]);
    const readSegmentMetadata = vi.fn(async ({ ordinal }: { ordinal: number }) => sidecars.get(ordinal) ?? null);
    const listSegmentOrdinals = vi.fn(async () => [...sidecars.keys()]);
    const onProgress = vi.fn();
    const run = createTtsPlaybackHandler({
      storage: {}, s3Prefix: 'test', ttsPlaybackSegmentTimeoutMs: 30_000,
      playbackStorage: {
        artifacts: { getScopeEpoch: async () => 3, listSegmentOrdinals, readSegmentMetadata },
        sessions: {
          getSession: async () => session,
          patchSessionIfGenerationRun: async () => session,
          watchGenerationInvalidation: async () => () => undefined,
        },
      },
    } as never);
    await run({
      userId: 'user', storageUserId: 'user', documentId: 'document', documentVersion: 1,
      readerType: 'epub', settingsHash: 'settings', settingsJson: {}, planning: {},
      sessionId: 'session', generationRunId: 'run', planObjectKey: 'plan',
    }, 0, { onProgress });
    expect(listSegmentOrdinals).toHaveBeenCalledTimes(1);
    expect(readSegmentMetadata.mock.calls.map(([scope]) => scope.ordinal)).toEqual([2, 7, 8_000]);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ completedCount: 1, completedThroughOrdinal: 2 }));
    expect(generateExplicitTtsPlaybackSegments).toHaveBeenCalledTimes(1);
  });
});

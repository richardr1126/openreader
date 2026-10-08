import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createTtsPlaybackHandler } from '../../src/jobs/playback/playback-job';
import { resolveAndPersistTtsPlaybackPlan } from '../../src/jobs/playback/plan';
import { generateExplicitTtsPlaybackSegments } from '../../src/jobs/playback/segment-generation';

vi.mock('../../src/jobs/playback/plan', () => ({ resolveAndPersistTtsPlaybackPlan: vi.fn() }));
vi.mock('../../src/jobs/playback/segment-generation', () => ({ generateExplicitTtsPlaybackSegments: vi.fn() }));

describe('playback job cache discovery', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  test('verifies cached audiobook sources once and generates only missing audio', async () => {
    const plannedSegments = Array.from({ length: 2234 }, (_, ordinal) => ({ ordinal, text: 'A sentence.' }));
    vi.mocked(resolveAndPersistTtsPlaybackPlan).mockResolvedValue({
      planObjectKey: 'plan', plannedSegments, startOrdinal: 0,
    } as never);
    const session = { sessionId: 'session', status: 'running', generationRunId: 'run' };
    const objectExists = vi.fn(async (key: string) => key !== 'audio/10');
    const patchSessionIfGenerationRun = vi.fn(async () => true);
    const onProgress = vi.fn();
    const run = createTtsPlaybackHandler({
      storage: { objectExists }, s3Prefix: 'test', ttsPlaybackSegmentTimeoutMs: 30_000,
      playbackStorage: {
        artifacts: {
          getScopeEpoch: async () => 3,
          listSegmentOrdinals: async () => plannedSegments.map((segment) => segment.ordinal),
          readSegmentMetadata: async ({ ordinal }: { ordinal: number }) => ({
            ordinal, status: 'completed', audioKey: `audio/${ordinal}`, durationMs: 1000, alignment: null,
            cacheEpoch: ordinal === 11 ? 2 : 3,
          }),
        },
        sessions: { getSession: async () => session, patchSessionIfGenerationRun },
      },
    } as never);
    await run({
      userId: 'user', storageUserId: 'user', documentId: 'document', documentVersion: 1,
      readerType: 'epub', settingsHash: 'settings', settingsJson: {}, planning: {},
      sessionId: 'session', generationRunId: 'run', planObjectKey: 'plan', generationExtent: 'document',
    }, 0, { onProgress });
    expect(onProgress.mock.calls[0][0].phase).toBe('checking_cache');
    expect(objectExists).toHaveBeenCalledTimes(2233);
    expect(vi.mocked(generateExplicitTtsPlaybackSegments).mock.calls[0][0].segments.map((segment) => segment.ordinal))
      .toEqual([10, 11]);
    expect(patchSessionIfGenerationRun).toHaveBeenCalledWith('session', 'run', expect.objectContaining({ status: 'succeeded' }));
  });

  test('starts a long book without reading unrelated cached chapters', async () => {
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
    expect(listSegmentOrdinals).not.toHaveBeenCalled();
    expect(readSegmentMetadata).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ completedCount: 0, completedThroughOrdinal: -1 }));
    expect(generateExplicitTtsPlaybackSegments).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateExplicitTtsPlaybackSegments).mock.calls[0][0].segments[0].ordinal).toBe(8_000);
  });

  test('starts interactive generation even when catalogue discovery never responds', async () => {
    vi.mocked(resolveAndPersistTtsPlaybackPlan).mockResolvedValue({
      planObjectKey: 'plan', plannedSegments: [{ ordinal: 8, text: 'A sentence.' }], startOrdinal: 8,
    } as never);
    const session = {
      sessionId: 'session', status: 'running', generationRunId: 'run', playbackActive: true,
      cursorOrdinal: 8, generationStartOrdinal: 8, expiresAt: Date.now() + 60_000,
    };
    const logger = { warn: vi.fn() };
    const run = createTtsPlaybackHandler({
      storage: {}, s3Prefix: 'test', ttsPlaybackSegmentTimeoutMs: 30_000, logger,
      playbackStorage: {
        artifacts: {
          getScopeEpoch: async () => 0,
          listSegmentOrdinals: async () => new Promise<number[]>(() => undefined),
          readSegmentMetadata: async () => null,
        },
        sessions: {
          getSession: async () => session,
          patchSessionIfGenerationRun: async () => session,
          watchGenerationInvalidation: async () => () => undefined,
        },
      },
    } as never);
    await expect(run({
      userId: 'user', storageUserId: 'user', documentId: 'document', documentVersion: 1,
      readerType: 'epub', settingsHash: 'settings', settingsJson: {}, planning: {},
      sessionId: 'session', generationRunId: 'run', planObjectKey: 'plan',
    }, 0)).resolves.toMatchObject({ sessionId: 'session' });
    expect(generateExplicitTtsPlaybackSegments).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('finishes document export generation when the first segment is terminally unrenderable', async () => {
    vi.mocked(resolveAndPersistTtsPlaybackPlan).mockResolvedValue({
      planObjectKey: 'plan', plannedSegments: [{ ordinal: 0, text: 'Unreadable.' }], startOrdinal: 0,
    } as never);
    const session = {
      sessionId: 'session', status: 'running', generationRunId: 'run', playbackActive: false,
      cursorOrdinal: 0, generationStartOrdinal: 0, expiresAt: Date.now() + 60_000,
    };
    vi.mocked(generateExplicitTtsPlaybackSegments).mockImplementation(async (input) => {
      await input.onSegmentErrored?.(0);
    });
    const patchSessionIfGenerationRun = vi.fn(async () => true);
    const onProgress = vi.fn();
    const run = createTtsPlaybackHandler({
      storage: {}, s3Prefix: 'test', ttsPlaybackSegmentTimeoutMs: 30_000,
      playbackStorage: {
        artifacts: {
          getScopeEpoch: async () => 0,
          listSegmentOrdinals: async () => [],
          readSegmentMetadata: async () => null,
        },
        sessions: {
          getSession: async () => session,
          patchSessionIfGenerationRun,
          watchGenerationInvalidation: async () => () => undefined,
        },
      },
    } as never);

    await expect(run({
      userId: 'user', storageUserId: 'user', documentId: 'document', documentVersion: 1,
      readerType: 'epub', settingsHash: 'settings', settingsJson: {}, planning: {},
      sessionId: 'session', generationRunId: 'run', planObjectKey: 'plan', generationExtent: 'document',
    }, 0, { onProgress })).resolves.toMatchObject({ sessionId: 'session' });
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      completedCount: 0, skippedCount: 1, plannedCount: 1,
    }));
    expect(patchSessionIfGenerationRun).toHaveBeenCalledWith(
      'session', 'run', expect.objectContaining({ status: 'succeeded' }),
    );
  });

  test('keeps a document export running past the live-session expiry but honors a stop', async () => {
    vi.mocked(resolveAndPersistTtsPlaybackPlan).mockResolvedValue({
      planObjectKey: 'plan',
      plannedSegments: [0, 1, 2].map((ordinal) => ({ ordinal, text: 'A sentence.' })),
      startOrdinal: 0,
    } as never);
    const session = {
      sessionId: 'session', status: 'running', generationRunId: null, playbackActive: true,
      cursorOrdinal: 0, generationStartOrdinal: 0,
      // A long export outlives the 30-minute live-session TTL.
      expiresAt: Date.now() - 1_000,
    };
    const decisions: string[] = [];
    vi.mocked(generateExplicitTtsPlaybackSegments).mockImplementation(async (input) => {
      for (const ordinal of [0, 1, 2]) {
        const decision = await input.onBeforeSegment!(ordinal);
        decisions.push(decision);
        if (decision === 'stop') return;
        await input.onSegmentCompleted?.(ordinal);
        if (ordinal === 1) session.status = 'canceled';
      }
    });
    const patchSessionIfGenerationRun = vi.fn(async () => true);
    const run = createTtsPlaybackHandler({
      storage: {}, s3Prefix: 'test', ttsPlaybackSegmentTimeoutMs: 30_000,
      playbackStorage: {
        artifacts: {
          getScopeEpoch: async () => 0,
          listSegmentOrdinals: async () => [],
          readSegmentMetadata: async () => null,
        },
        sessions: {
          getSession: async () => ({ ...session }),
          patchSessionIfGenerationRun,
          watchGenerationInvalidation: async () => () => undefined,
        },
      },
    } as never);

    await run({
      userId: 'user', storageUserId: 'user', documentId: 'document', documentVersion: 1,
      readerType: 'epub', settingsHash: 'settings', settingsJson: {}, planning: {},
      sessionId: 'session', planObjectKey: 'plan', generationExtent: 'document',
    }, 0);

    expect(decisions).toEqual(['continue', 'continue', 'stop']);
    // A stopped run is resumable: it is neither completed nor failed.
    expect(patchSessionIfGenerationRun).not.toHaveBeenCalledWith(
      'session', null, expect.objectContaining({ status: expect.stringMatching(/succeeded|failed/) }),
    );
  });

  test('stops a document export run once a resumed run supersedes it', async () => {
    vi.mocked(resolveAndPersistTtsPlaybackPlan).mockResolvedValue({
      planObjectKey: 'plan',
      plannedSegments: [0, 1, 2].map((ordinal) => ({ ordinal, text: 'A sentence.' })),
      startOrdinal: 0,
    } as never);
    const session = {
      sessionId: 'session', status: 'running', generationRunId: 'run-1', playbackActive: true,
      cursorOrdinal: 0, generationStartOrdinal: 0, expiresAt: Date.now() + 60_000,
    };
    const decisions: string[] = [];
    vi.mocked(generateExplicitTtsPlaybackSegments).mockImplementation(async (input) => {
      for (const ordinal of [0, 1, 2]) {
        const decision = await input.onBeforeSegment!(ordinal);
        decisions.push(decision);
        if (decision === 'stop') return;
        // Resume/retry started a new run while this one was draining.
        session.generationRunId = 'run-2';
      }
    });
    const run = createTtsPlaybackHandler({
      storage: {}, s3Prefix: 'test', ttsPlaybackSegmentTimeoutMs: 30_000,
      playbackStorage: {
        artifacts: { getScopeEpoch: async () => 0, listSegmentOrdinals: async () => [], readSegmentMetadata: async () => null },
        sessions: {
          getSession: async () => ({ ...session }),
          patchSessionIfGenerationRun: async () => true,
          watchGenerationInvalidation: async () => () => undefined,
        },
      },
    } as never);

    await run({
      userId: 'user', storageUserId: 'user', documentId: 'document', documentVersion: 1,
      readerType: 'epub', settingsHash: 'settings', settingsJson: {}, planning: {},
      sessionId: 'session', generationRunId: 'run-1', planObjectKey: 'plan', generationExtent: 'document',
    }, 0);

    expect(decisions).toEqual(['continue', 'stop']);
  });
});

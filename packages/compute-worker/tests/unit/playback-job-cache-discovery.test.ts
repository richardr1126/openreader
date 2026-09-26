import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createTtsPlaybackHandler } from '../../src/jobs/playback/playback-job';
import { resolveAndPersistTtsPlaybackPlan } from '../../src/jobs/playback/plan';
import { generateExplicitTtsPlaybackSegments } from '../../src/jobs/playback/segment-generation';

vi.mock('../../src/jobs/playback/plan', () => ({ resolveAndPersistTtsPlaybackPlan: vi.fn() }));
vi.mock('../../src/jobs/playback/segment-generation', () => ({ generateExplicitTtsPlaybackSegments: vi.fn() }));

describe('playback job cache discovery', () => {
  beforeEach(() => { vi.clearAllMocks(); });

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

  test('continues with per-segment cache checks when catalogue discovery is unavailable', async () => {
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
          listSegmentOrdinals: async () => { throw new Error('catalogue unavailable'); },
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
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session', error: 'catalogue unavailable',
    }), 'tts.playback.cache_catalogue_read_failed');
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

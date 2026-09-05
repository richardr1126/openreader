import { describe, expect, test, vi } from 'vitest';
import Fastify from 'fastify';

import { createPlaybackSessionController } from '../../src/api/playback/session-controller';
import type {
  PlaybackSessionReadModel,
  PlaybackSessionRow,
} from '../../src/api/playback/session-read-model';
import type { ComputeWorkerRouteContext } from '../../src/api/route-context';
import type { TtsPlaybackStorage } from '../../src/playback/storage';
import { resolveTtsPlaybackSessionInstanceId } from '../../src/playback/storage';
import { registerPlaybackSessionRoutes } from '../../src/api/routes/playback/sessions';

function playbackSession(overrides: Partial<PlaybackSessionRow> = {}): PlaybackSessionRow {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    userId: 'user-1',
    storageUserId: 'storage-1',
    documentId: 'a'.repeat(64),
    documentVersion: 1,
    readerType: 'epub',
    status: 'running',
    workerOpId: 'terminal-op',
    settingsHash: 'settings-1',
    settingsJson: {},
    aheadWindow: 8,
    backgroundExtent: 'section',
    generationExtent: 'window',
    playbackActive: true,
    generationRunId: 'initial:12',
    sessionInstanceId: 'instance-1',
    planning: { selectedOrdinal: 12 },
    generationStartOrdinal: 12,
    cursorOrdinal: 12,
    cursorUpdatedAt: 1,
    planObjectKey: 'plans/session-1.json',
    expiresAt: Date.now() + 60_000,
    lastError: null,
    updatedAt: 1,
    ...overrides,
  };
}

function createFixture(
  initial: PlaybackSessionRow,
  workerOpStatus: 'queued' | 'running' | 'succeeded' | 'failed' = 'succeeded',
) {
  let session = initial;
  const enqueueOrReuse = vi.fn(async (request: { opKey: string }) => ({
    opId: 'continuation-op',
    jobId: 'continuation-job',
    status: 'queued' as const,
    error: null,
    request,
  }));
  const updateCursor = vi.fn(async (
    _sessionId: string,
    ordinal: number,
    _expectedSessionInstanceId: string,
    updatedAt?: number,
  ) => {
    session = { ...session, cursorOrdinal: ordinal, cursorUpdatedAt: updatedAt ?? Date.now() };
    return true;
  });
  const patchSession = vi.fn(async (_sessionId: string, patch: Partial<PlaybackSessionRow>) => {
    session = { ...session, ...patch };
  });
  const patchSessionIfGenerationRun = vi.fn(async (
    _sessionId: string,
    expectedGenerationRunId: string | null,
    patch: Partial<PlaybackSessionRow>,
  ) => {
    if ((session.generationRunId ?? null) !== expectedGenerationRunId) return false;
    session = { ...session, ...patch };
    return true;
  });
  const playbackStorage = {
    sessions: {
      async getSession() { return session; },
      async putSessionIfNewer(next: PlaybackSessionRow) {
        if (next.expiresAt <= session.expiresAt) {
          return (next.generationRunId ?? null) === (session.generationRunId ?? null);
        }
        session = { ...next, sessionInstanceId: resolveTtsPlaybackSessionInstanceId(next) };
        return true;
      },
      patchSession,
      patchSessionIfGenerationRun,
      updateCursor,
      async watchGenerationInvalidation() { return () => undefined; },
      async listSessions() { return [session]; },
      async cancelSessionsForScope() { return 0; },
    },
    artifacts: {
      sidecarKey() { return ''; },
      async listSegmentOrdinals() { return []; },
      async putSegmentMetadata() { return ''; },
      async readSegmentMetadata() { return null; },
      async getScopeEpoch() { return 0; },
      async incrementScopeEpoch() { return 0; },
    },
  } satisfies TtsPlaybackStorage;
  const readModel = {
    async readSession() { return session; },
  } as unknown as PlaybackSessionReadModel;
  const context = {
    app: { log: { warn: vi.fn(), info: vi.fn() } },
    deps: { orchestrator: { enqueueOrReuse } },
    playbackStorage,
    ensureOrphanedOpRecovery: vi.fn(async () => undefined),
    getOpState: vi.fn(async () => ({ status: workerOpStatus })),
  } as unknown as ComputeWorkerRouteContext;
  return {
    controller: createPlaybackSessionController(context, readModel),
    enqueueOrReuse,
    updateCursor,
    currentSession: () => session,
    context,
    readModel,
  };
}

describe('playback session continuation controller', () => {
  test('does not reuse a completed partial run when resuming at the same cursor', async () => {
    const fixture = createFixture(playbackSession({ generationRunId: 'active:12' }));
    await fixture.controller.enqueueContinuationIfNeeded(fixture.currentSession(), Date.now(), 'cursor');
    const first = fixture.enqueueOrReuse.mock.calls[0][0].opKey;
    const instance = fixture.currentSession().sessionInstanceId;
    await fixture.controller.enqueueContinuationIfNeeded(fixture.currentSession(), Date.now(), 'cursor');
    expect(fixture.enqueueOrReuse.mock.calls[1][0].opKey).not.toBe(first);
    expect(fixture.currentSession().sessionInstanceId).toBe(instance);
    expect(fixture.currentSession().sessionId).toBe('session-1');
  });

  test('preparation queues nothing until activation and rejects a delayed old pause', async () => {
    const fixture = createFixture(playbackSession({ expiresAt: 1 }));
    const app = Fastify();
    registerPlaybackSessionRoutes({ ...fixture.context, app } as ComputeWorkerRouteContext,
      fixture.readModel, fixture.controller);
    try {
      const payload = {
        sessionId: 'session-1', userId: 'user-1', storageUserId: 'storage-1',
        documentId: 'a'.repeat(64), documentVersion: 1, readerType: 'epub',
        settingsHash: 'settings-1', settingsJson: {}, planObjectKey: 'plans/session-1.json',
        planning: { selectedOrdinal: 12 }, generationRunId: 'prepared:first', expiresAt: Date.now() + 60_000,
      };
      const prepared = await app.inject({ method: 'POST', url: '/v1/tts-playback/sessions/prepare', payload });
      expect(prepared.statusCode).toBe(200);
      expect(fixture.currentSession()).toMatchObject({ playbackActive: false, workerOpId: null });
      await fixture.controller.updateCursor('session-1', 12, { ensureGeneration: true });
      expect(fixture.enqueueOrReuse).not.toHaveBeenCalled();
      const firstInstance = prepared.json().sessionInstanceId;
      const activated = await app.inject({ method: 'PUT', url: '/v1/tts-playback/sessions/session-1/cursor',
        payload: { ordinal: 12, playbackActive: true, sessionInstanceId: firstInstance } });
      expect(activated.statusCode).toBe(200);
      expect(activated.json().workerOpId).toBe('continuation-op');
      expect(fixture.enqueueOrReuse).toHaveBeenCalledTimes(1);
      await app.inject({ method: 'POST', url: '/v1/tts-playback/sessions/prepare',
        payload: { ...payload, generationRunId: 'prepared:second', expiresAt: payload.expiresAt + 1 } });
      const late = await app.inject({ method: 'PUT', url: '/v1/tts-playback/sessions/session-1/cursor',
        payload: { ordinal: 99, playbackActive: true, sessionInstanceId: firstInstance } });
      expect(late.statusCode).toBe(409);
      expect(fixture.currentSession()).toMatchObject({ playbackActive: false, cursorOrdinal: 12 });
      expect(fixture.enqueueOrReuse).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });

  test('does not enqueue cursor or stream continuations while explicitly paused', async () => {
    const fixture = createFixture(playbackSession({ playbackActive: false }));

    await fixture.controller.enqueueContinuationIfNeeded(
      fixture.currentSession(),
      Date.now(),
      'cursor',
    );
    await fixture.controller.updateCursor('session-1', 13, { ensureGeneration: true });

    expect(fixture.updateCursor).toHaveBeenCalledWith(
      'session-1',
      13,
      'instance-1',
      expect.any(Number),
    );
    expect(fixture.enqueueOrReuse).not.toHaveBeenCalled();
  });

  test('updates an ordinarily consumed stream cursor without enqueueing generation', async () => {
    const fixture = createFixture(playbackSession());

    await fixture.controller.updateCursor('session-1', 13);

    expect(fixture.currentSession().cursorOrdinal).toBe(13);
    expect(fixture.enqueueOrReuse).not.toHaveBeenCalled();
  });

  test('collapses cursor and blocked-stream signals for one active cursor onto one run identity', async () => {
    const fixture = createFixture(playbackSession());
    const now = Date.now();

    await fixture.controller.enqueueContinuationIfNeeded(
      fixture.currentSession(),
      now,
      'cursor',
    );
    const firstRequest = fixture.enqueueOrReuse.mock.calls[0]?.[0];

    // Present the same terminal predecessor to model a cursor/stream race. Both
    // callers should ask the orchestrator for the same idempotent operation.
    const sameCursorSession = playbackSession();
    await fixture.controller.enqueueContinuationIfNeeded(sameCursorSession, now, 'stream');
    const secondRequest = fixture.enqueueOrReuse.mock.calls[1]?.[0];

    expect(firstRequest?.opKey).toBe(secondRequest?.opKey);
    expect(fixture.currentSession()).toMatchObject({
      playbackActive: true,
      generationRunId: expect.stringMatching(/^active:12:/),
    });
  });

  test('does not let a stale continuation supersede a newer generation claim', async () => {
    const fixture = createFixture(playbackSession({
      cursorOrdinal: 20,
      generationRunId: 'active:20',
    }));

    await fixture.controller.enqueueContinuationIfNeeded(
      playbackSession({ cursorOrdinal: 12, generationRunId: 'initial:12' }),
      Date.now(),
      'cursor',
    );

    expect(fixture.enqueueOrReuse).not.toHaveBeenCalled();
    expect(fixture.currentSession().generationRunId).toBe('active:20');
  });

  test('refills only after playback crosses the satisfied-window low-water mark', async () => {
    const satisfied = playbackSession({
      generationSatisfiedFromOrdinal: 12,
      generationSatisfiedThroughOrdinal: 20,
    });
    const fixture = createFixture(satisfied);

    await fixture.controller.enqueueContinuationIfNeeded(satisfied, Date.now(), 'cursor');
    expect(fixture.enqueueOrReuse).not.toHaveBeenCalled();

    await fixture.controller.enqueueContinuationIfNeeded({
      ...satisfied,
      cursorOrdinal: 15,
    }, Date.now(), 'cursor');
    expect(fixture.enqueueOrReuse).toHaveBeenCalledTimes(1);
  });

  test('does not supersede active synthesis before it publishes a satisfied window', async () => {
    const fixture = createFixture(playbackSession(), 'running');

    await fixture.controller.enqueueContinuationIfNeeded(
      fixture.currentSession(),
      Date.now(),
      'cursor',
    );

    expect(fixture.enqueueOrReuse).not.toHaveBeenCalled();
  });

  test('supersedes active synthesis immediately when an audio range repositions the cursor', async () => {
    const fixture = createFixture(playbackSession(), 'running');

    await fixture.controller.updateCursor('session-1', 24, { ensureGeneration: true });

    expect(fixture.enqueueOrReuse).toHaveBeenCalledTimes(1);
    expect(fixture.currentSession()).toMatchObject({
      cursorOrdinal: 24,
      generationRunId: expect.stringMatching(/^active:24:/),
    });
  });

  test('refills audio while the active predecessor drains exact alignment', async () => {
    const fixture = createFixture(playbackSession({
      cursorOrdinal: 15,
      generationSatisfiedFromOrdinal: 12,
      generationSatisfiedThroughOrdinal: 20,
    }), 'running');

    await fixture.controller.enqueueContinuationIfNeeded(
      fixture.currentSession(),
      Date.now(),
      'cursor',
    );

    expect(fixture.enqueueOrReuse).toHaveBeenCalledTimes(1);
    expect(fixture.currentSession()).toMatchObject({
      generationRunId: expect.stringMatching(/^active:15:/),
      generationSatisfiedFromOrdinal: null,
      generationSatisfiedThroughOrdinal: null,
    });
  });
});

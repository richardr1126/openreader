import Fastify from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { registerHealthRoutes } from '../../src/api/routes/health';
import { registerPlaybackExportSessionRoutes } from '../../src/api/routes/playback/exports';
import type { PlaybackSessionReadModel } from '../../src/api/playback/session-read-model';
import type { ComputeWorkerRouteContext } from '../../src/api/route-context';

describe('compute worker domain route registrars', () => {
  const apps: ReturnType<typeof Fastify>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  test('registers health routes without booting unrelated route domains', async () => {
    const app = Fastify();
    apps.push(app);
    registerHealthRoutes({
      app,
      getNatsConnected: () => false,
    } as unknown as ComputeWorkerRouteContext);

    await expect(app.inject({ method: 'GET', url: '/health/live' })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: 'GET', url: '/health/ready' })).resolves.toMatchObject({
      statusCode: 200,
      body: JSON.stringify({ ok: true, natsConnected: false }),
    });
    await expect(app.inject({ method: 'GET', url: '/v1/operations/op-1' })).resolves.toMatchObject({ statusCode: 404 });
  });

  test('cancels an export session only for the run the caller observed', async () => {
    const app = Fastify();
    apps.push(app);
    let session = { sessionId: 'session-1', status: 'running', generationRunId: 'run-2', sessionInstanceId: 'instance-1' };
    const patches: Array<{ expectedRunId: string | null }> = [];
    registerPlaybackExportSessionRoutes({
      app,
      storage: {},
      playbackStorage: {
        sessions: {
          getSession: async () => session,
          patchSessionIfGenerationRun: async (_id: string, expectedRunId: string | null, patch: { status: string }) => {
            patches.push({ expectedRunId });
            if (expectedRunId !== session.generationRunId) return false;
            session = { ...session, status: patch.status };
            return true;
          },
        },
      },
    } as unknown as ComputeWorkerRouteContext, {} as PlaybackSessionReadModel);

    const stale = await app.inject({
      method: 'POST',
      url: '/v1/tts-playback/sessions/session-1/cancel',
      payload: { generationRunId: 'run-1' },
    });
    expect(stale.json()).toEqual({ sessionId: 'session-1', canceled: false, status: 'running' });

    const current = await app.inject({
      method: 'POST',
      url: '/v1/tts-playback/sessions/session-1/cancel',
      payload: { generationRunId: 'run-2' },
    });
    expect(current.json()).toEqual({ sessionId: 'session-1', canceled: true, status: 'canceled' });
    expect(patches).toEqual([{ expectedRunId: 'run-1' }, { expectedRunId: 'run-2' }]);
  });

  test('summarizes export progress per plan chapter', async () => {
    const app = Fastify();
    apps.push(app);
    const plan = {
      schemaVersion: 1,
      segments: [
        { ordinal: 0, text: 'One.', locator: { readerType: 'pdf', page: 1 } },
        { ordinal: 1, text: 'Two.', locator: { readerType: 'pdf', page: 1 } },
        { ordinal: 2, text: 'Three.', locator: { readerType: 'pdf', page: 2 } },
      ],
    };
    registerPlaybackExportSessionRoutes({
      app,
      storage: { readObject: async () => Buffer.from(JSON.stringify(plan)) },
    } as unknown as ComputeWorkerRouteContext, {
      readSession: async () => ({
        sessionId: 'session-1', status: 'running', stopReason: null, lastError: null, planObjectKey: 'plan.json',
      }),
      listSegmentStates: async () => new Map([
        [0, { status: 'completed', durationMs: 1_500 }],
        [1, { status: 'error', message: 'fetch failed', code: null }],
        [2, { status: 'generating' }],
      ]),
    } as unknown as PlaybackSessionReadModel);

    const response = await app.inject({ method: 'GET', url: '/v1/tts-playback/sessions/session-1/export-progress' });

    expect(response.json()).toMatchObject({
      plannedSegments: 3,
      completedSegments: 1,
      skippedSegments: 1,
      lastSkipError: { message: 'fetch failed', code: null },
      chapters: [
        { index: 0, title: 'Page 1', page: 1, plannedSegments: 2, completedSegments: 1, skippedSegments: 1, durationMs: 1_500 },
        { index: 1, title: 'Page 2', page: 2, plannedSegments: 1, completedSegments: 0, generatingSegments: 1 },
      ],
    });
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createComputeWorkerApp } from '../../src/api/app';
import { buildTtsPlaybackOperationKey } from '../../src/operations/keys';
import { FakeControlPlane } from '../fixtures/fake-control-plane';

const AUTH = { authorization: 'Bearer test-token' };

describe('compute worker API routes', () => {
  let fake: FakeControlPlane;
  let runtime: Awaited<ReturnType<typeof createComputeWorkerApp>>;

  beforeEach(async () => {
    fake = new FakeControlPlane();
    runtime = await createComputeWorkerApp({
      workerToken: 'test-token',
      disableWorkers: true,
      routeDeps: fake.deps,
    });
  });

  afterEach(async () => {
    await runtime.close();
  });

  test('allows unauthenticated health checks but protects operation routes', async () => {
    const live = await runtime.app.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);

    const protectedRoute = await runtime.app.inject({ method: 'GET', url: '/v1/operations/op-1' });
    expect(protectedRoute.statusCode).toBe(401);
  });

  test('allows public playback audio route through bearer auth but requires a signed playback token', async () => {
    const missing = await runtime.app.inject({
      method: 'GET',
      url: '/v1/tts-playback/session-1/audio',
    });
    expect(missing.statusCode).toBe(400);

    const invalid = await runtime.app.inject({
      method: 'GET',
      url: '/v1/tts-playback/session-1/audio?token=not-a-token',
    });
    expect(invalid.statusCode).toBe(403);
  });

  test('validates operation creation body and returns 400 for invalid payload', async () => {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/v1/pdf-layout/operations',
      headers: AUTH,
      payload: {
        documentId: '',
        namespace: null,
        documentObjectKey: 'openreader/doc.pdf',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Bad Request' });
  });

  test('creates operation and fetches state by op id', async () => {
    const documentId = 'c'.repeat(64);
    const create = await runtime.app.inject({
      method: 'POST',
      url: '/v1/pdf-layout/operations',
      headers: AUTH,
      payload: {
        documentId,
        namespace: null,
        documentObjectKey: `openreader/${documentId}.pdf`,
      },
    });

    expect(create.statusCode).toBe(202);
    const created = create.json();
    expect(created).toMatchObject({
      subject: { kind: 'pdf_layout', documentId, namespace: null },
      status: 'queued',
    });
    expect(created).not.toHaveProperty('opKey');
    expect(created).not.toHaveProperty('jobId');

    const fetch = await runtime.app.inject({
      method: 'GET',
      url: `/v1/operations/${created.opId}`,
      headers: AUTH,
    });

    expect(fetch.statusCode).toBe(200);
    expect(fetch.json()).toMatchObject({ opId: created.opId, status: 'queued' });
  });

  test('reuses idempotent PDF requests and replaces them only with an explicit token', async () => {
    const documentId = 'e'.repeat(64);
    const payload = {
      documentId,
      namespace: null,
      documentObjectKey: `openreader/${documentId}.pdf`,
    };
    const create = (body: typeof payload & { replaceToken?: string }) => runtime.app.inject({
      method: 'POST',
      url: '/v1/pdf-layout/operations',
      headers: AUTH,
      payload: body,
    });

    const initial = (await create(payload)).json();
    const reused = (await create(payload)).json();
    const replacement = (await create({ ...payload, replaceToken: 'replace-1' })).json();

    expect(reused.opId).toBe(initial.opId);
    expect(replacement.opId).not.toBe(initial.opId);
    expect(replacement.subject).toEqual(initial.subject);
  });

  test('creates TTS playback operations without exposing internal keys', async () => {
    const documentId = 'b'.repeat(64);
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/v1/tts-playback/operations',
      headers: AUTH,
      payload: {
        sessionId: 'playback-session-1',
        userId: 'user-1',
        storageUserId: 'user-1',
        documentId,
        documentVersion: 123,
        readerType: 'pdf',
        settingsHash: 'settings-hash',
        settingsJson: { voice: 'alloy' },
        planObjectKey: 'plans/playback-session-1.json',
        planning: {
          selectedOrdinal: 4,
          maxBlockLength: 500,
          enforceSourceBoundaries: true,
          language: 'en',
          documentSource: {
            namespace: null,
            extent: 'section',
          },
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      subject: { kind: 'tts_playback', documentId, sessionId: 'playback-session-1' },
      status: 'queued',
    });
    expect(response.json()).not.toHaveProperty('opKey');
    expect(fake.enqueuedRequests.at(-1)).toMatchObject({
      kind: 'tts_playback',
      payload: {
        planning: {
          selectedOrdinal: 4,
          documentSource: {
            namespace: null,
            extent: 'section',
          },
        },
      },
    });
  });

  test('rejects TTS playback operations without a worker-plan ordinal', async () => {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/v1/tts-playback/operations',
      headers: AUTH,
      payload: {
        sessionId: 'playback-session-missing-ordinal',
        userId: 'user-1',
        storageUserId: 'user-1',
        documentId: 'c'.repeat(64),
        documentVersion: 123,
        readerType: 'pdf',
        settingsHash: 'settings-hash',
        settingsJson: { voice: 'alloy' },
        planObjectKey: 'plans/playback-session-missing-ordinal.json',
        planning: {
          maxBlockLength: 500,
          enforceSourceBoundaries: true,
          language: 'en',
          documentSource: {
            namespace: null,
            extent: 'section',
          },
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'TTS playback operation requires a worker-plan ordinal',
    });
  });

  test('creates isolated TTS playback plan operations', async () => {
    const documentId = 'f'.repeat(64);
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/v1/tts-playback-plans/operations',
      headers: AUTH,
      payload: {
        userId: 'user-1',
        storageUserId: 'user-1',
        documentId,
        documentVersion: 123,
        readerType: 'pdf',
        settingsHash: 'settings-hash',
        settingsJson: { providerRef: 'p', providerType: 'openai', ttsModel: 'm', voice: 'v', nativeSpeed: 1 },
        planning: {
          maxBlockLength: 500,
          enforceSourceBoundaries: true,
          language: 'en',
          documentSource: {
            namespace: null,
            extent: 'document',
          },
        },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      subject: { kind: 'tts_playback_plan', documentId, settingsHash: 'settings-hash' },
      status: 'queued',
    });
    expect(fake.enqueuedRequests.at(-1)).toMatchObject({
      kind: 'tts_playback_plan',
      payload: {
        documentId,
        planning: {
          documentSource: {
            namespace: null,
            extent: 'document',
          },
        },
      },
    });
  });

  test('resolves the current PDF artifact and operation without exposing parser identity', async () => {
    const documentId = 'a'.repeat(64);
    const create = await runtime.app.inject({
      method: 'POST',
      url: '/v1/pdf-layout/operations',
      headers: AUTH,
      payload: {
        documentId,
        namespace: null,
        documentObjectKey: `openreader/${documentId}.pdf`,
      },
    });
    expect(create.statusCode).toBe(202);

    const artifactKey = `openreader/documents_v1/parsed_v2/${documentId}/pp-doclayoutv3-onnx%40800%2Bpdfjs%404.8.69.json`;
    fake.seedArtifact(artifactKey);
    const resolve = await runtime.app.inject({
      method: 'POST',
      url: '/v1/pdf-layout/resolve',
      headers: AUTH,
      payload: {
        documentId,
        namespace: null,
        documentObjectKey: `openreader/${documentId}.pdf`,
      },
    });

    expect(resolve.statusCode).toBe(200);
    expect(resolve.json()).toMatchObject({
      artifact: { objectKey: artifactKey },
      operation: {
        subject: { kind: 'pdf_layout', documentId, namespace: null },
      },
    });
    expect(resolve.json().operation).not.toHaveProperty('opKey');
  });

  test('resolves a current PDF artifact after operation state has expired', async () => {
    const documentId = 'd'.repeat(64);
    const artifactKey = `openreader/documents_v1/parsed_v2/${documentId}/pp-doclayoutv3-onnx%40800%2Bpdfjs%404.8.69.json`;
    fake.seedArtifact(artifactKey);

    const resolve = await runtime.app.inject({
      method: 'POST',
      url: '/v1/pdf-layout/resolve',
      headers: AUTH,
      payload: {
        documentId,
        namespace: null,
        documentObjectKey: `openreader/${documentId}.pdf`,
      },
    });

    expect(resolve.statusCode).toBe(200);
    expect(resolve.json()).toEqual({
      artifact: { objectKey: artifactKey },
      operation: null,
    });
  });

  test('returns not found for unknown operation and event stream lookups', async () => {
    const opResponse = await runtime.app.inject({
      method: 'GET',
      url: '/v1/operations/missing',
      headers: AUTH,
    });
    expect(opResponse.statusCode).toBe(404);

    const eventsResponse = await runtime.app.inject({
      method: 'GET',
      url: '/v1/operations/missing/events',
      headers: AUTH,
    });
    expect(eventsResponse.statusCode).toBe(404);
  });

  test('streams initial SSE snapshot for terminal operation and honors cursor id', async () => {
    fake.seedState({
      opId: 'op-terminal',
      opKey: 'k-terminal',
      kind: 'pdf_layout',
      jobId: 'job-op-terminal',
      status: 'succeeded',
      queuedAt: 1000,
      updatedAt: 2000,
      result: { parsedObjectKey: 'openreader/parsed.json' },
    });

    const stream = await runtime.app.inject({
      method: 'GET',
      url: '/v1/operations/op-terminal/events?sinceEventId=7',
      headers: AUTH,
    });

    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain('event: snapshot');
    expect(stream.body).toContain('id: 7');
    expect(stream.body).toContain('"status":"succeeded"');
  });

  test('streams TTS playback completed-count progress in SSE snapshots', async () => {
    const now = Date.now();
    fake.seedState({
      opId: 'op-tts-progress',
      opKey: buildTtsPlaybackOperationKey({
        sessionId: 'playback-session-progress',
        storageUserId: 'storage-progress',
        documentId: 'doc-progress',
        documentVersion: 1,
        readerType: 'epub',
        settingsHash: 'settings-progress',
        planObjectKey: 'plans/doc-progress/settings-progress.json',
      }),
      kind: 'tts_playback',
      jobId: 'job-op-tts-progress',
      status: 'succeeded',
      queuedAt: now,
      updatedAt: now,
      progress: {
        completedThroughOrdinal: 8,
        completedCount: 7,
        plannedCount: 14,
      },
    });

    const stream = await runtime.app.inject({
      method: 'GET',
      url: '/v1/operations/op-tts-progress/events',
      headers: AUTH,
    });

    expect(stream.statusCode).toBe(200);
    expect(stream.body).toContain('"completedThroughOrdinal":8');
    expect(stream.body).toContain('"completedCount":7');
    expect(stream.body).toContain('"plannedCount":14');
  });

  test('marks stale running playback and pdf ops failed during request-time orphan recovery but leaves queued ops on the conservative path', async () => {
    const now = Date.now();
    fake.seedState({
      opId: 'op-stale-playback-running',
      opKey: 'k-stale-playback-running',
      kind: 'tts_playback',
      jobId: 'job-op-stale-playback-running',
      status: 'running',
      queuedAt: 1,
      updatedAt: now - 40_000,
    });
    fake.seedState({
      opId: 'op-stale-playback-queued',
      opKey: 'k-stale-playback-queued',
      kind: 'tts_playback',
      jobId: 'job-op-stale-playback-queued',
      status: 'queued',
      queuedAt: 1,
      updatedAt: now - 40_000,
    });
    fake.seedState({
      opId: 'op-stale-pdf-running',
      opKey: 'k-stale-pdf-running',
      kind: 'pdf_layout',
      jobId: 'job-op-stale-pdf-running',
      status: 'running',
      queuedAt: 1,
      updatedAt: now - 310_000,
    });
    fake.seedState({
      opId: 'op-stale-pdf-queued',
      opKey: 'k-stale-pdf-queued',
      kind: 'pdf_layout',
      jobId: 'job-op-stale-pdf-queued',
      status: 'queued',
      queuedAt: 1,
      updatedAt: now - 310_000,
    });

    // GET /v1/operations/:opId resolves via getOpState(), which first awaits the shared
    // orphanRecoveryPromise path through ensureOrphanedOpRecovery().
    const fetch = await runtime.app.inject({
      method: 'GET',
      url: '/v1/operations/op-stale-playback-running',
      headers: AUTH,
    });

    expect(fetch.statusCode).toBe(200);
    expect(fetch.json()).toMatchObject({
      opId: 'op-stale-playback-running',
      status: 'failed',
      error: {
        code: 'WORKER_ORPHANED_OP',
      },
    });
    expect(fake.getState('op-stale-playback-running')).toMatchObject({
      status: 'failed',
      error: {
        code: 'WORKER_ORPHANED_OP',
      },
    });
    expect(fake.getState('op-stale-playback-queued')).toMatchObject({
      status: 'queued',
    });
    expect(fake.getState('op-stale-pdf-running')).toMatchObject({
      status: 'failed',
      error: {
        code: 'WORKER_ORPHANED_OP',
      },
    });
    expect(fake.getState('op-stale-pdf-queued')).toMatchObject({
      status: 'queued',
    });
  });
});

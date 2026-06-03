import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createComputeWorkerApp } from '../../src/runtime';
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

    const protectedRoute = await runtime.app.inject({ method: 'GET', url: '/ops/op-1' });
    expect(protectedRoute.statusCode).toBe(401);
  });

  test('validates operation creation body and returns 400 for invalid payload', async () => {
    const response = await runtime.app.inject({
      method: 'POST',
      url: '/ops',
      headers: AUTH,
      payload: {
        kind: 'pdf_layout',
        opKey: '',
        payload: {
          documentId: 'd1',
          namespace: null,
          documentObjectKey: 's3://bucket/doc.pdf',
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Invalid request body' });
  });

  test('creates operation and fetches state by op id', async () => {
    const create = await runtime.app.inject({
      method: 'POST',
      url: '/ops',
      headers: AUTH,
      payload: {
        kind: 'pdf_layout',
        opKey: 'doc-1:layout',
        payload: {
          documentId: 'doc-1',
          namespace: null,
          documentObjectKey: 'openreader/doc-1.pdf',
        },
      },
    });

    expect(create.statusCode).toBe(202);
    const created = create.json();
    expect(created).toMatchObject({ kind: 'pdf_layout', status: 'queued' });

    const fetch = await runtime.app.inject({
      method: 'GET',
      url: `/ops/${created.opId}`,
      headers: AUTH,
    });

    expect(fetch.statusCode).toBe(200);
    expect(fetch.json()).toMatchObject({ opId: created.opId, status: 'queued' });
  });

  test('returns not found for unknown operation and event stream lookups', async () => {
    const opResponse = await runtime.app.inject({
      method: 'GET',
      url: '/ops/missing',
      headers: AUTH,
    });
    expect(opResponse.statusCode).toBe(404);

    const eventsResponse = await runtime.app.inject({
      method: 'GET',
      url: '/ops/missing/events',
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
      url: '/ops/op-terminal/events?sinceEventId=7',
      headers: AUTH,
    });

    expect(stream.statusCode).toBe(200);
    expect(stream.headers['content-type']).toContain('text/event-stream');
    expect(stream.body).toContain('event: snapshot');
    expect(stream.body).toContain('id: 7');
    expect(stream.body).toContain('"status":"succeeded"');
  });

  test('marks stale running whisper and pdf ops failed during request-time orphan recovery but leaves queued ops on the conservative path', async () => {
    const now = Date.now();
    fake.seedState({
      opId: 'op-stale-whisper-running',
      opKey: 'k-stale-whisper-running',
      kind: 'whisper_align',
      jobId: 'job-op-stale-whisper-running',
      status: 'running',
      queuedAt: 1,
      updatedAt: now - 40_000,
    });
    fake.seedState({
      opId: 'op-stale-whisper-queued',
      opKey: 'k-stale-whisper-queued',
      kind: 'whisper_align',
      jobId: 'job-op-stale-whisper-queued',
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

    // GET /ops/:opId resolves via getOpState(), which first awaits the shared
    // orphanRecoveryPromise path through ensureOrphanedOpRecovery().
    const fetch = await runtime.app.inject({
      method: 'GET',
      url: '/ops/op-stale-whisper-running',
      headers: AUTH,
    });

    expect(fetch.statusCode).toBe(200);
    expect(fetch.json()).toMatchObject({
      opId: 'op-stale-whisper-running',
      status: 'failed',
      error: {
        code: 'WORKER_ORPHANED_OP',
      },
    });
    expect(fake.getState('op-stale-whisper-running')).toMatchObject({
      status: 'failed',
      error: {
        code: 'WORKER_ORPHANED_OP',
      },
    });
    expect(fake.getState('op-stale-whisper-queued')).toMatchObject({
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

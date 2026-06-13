import { afterEach, describe, expect, test } from 'vitest';
import { createComputeWorkerApp, type ComputeWorkerApp } from '../../packages/compute-worker/src/api/app';
import { FakeControlPlane } from '../../packages/compute-worker/tests/fixtures/fake-control-plane';
import { ComputeWorkerClient } from '../../src/lib/server/compute-worker/client';

describe('ComputeWorkerClient contract', () => {
  let runtime: ComputeWorkerApp | null = null;

  afterEach(async () => {
    await runtime?.close();
    runtime = null;
  });

  test('exercises the real Fastify API through the app-owned HTTP client', async () => {
    process.env.NATS_URL = 'nats://127.0.0.1:4222';
    const fake = new FakeControlPlane();
    runtime = await createComputeWorkerApp({
      host: '127.0.0.1',
      port: 0,
      workerToken: 'contract-token',
      disableWorkers: true,
      routeDeps: fake.deps,
    });
    await runtime.start();

    const address = runtime.app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Compute worker did not bind a TCP port');
    }
    const client = new ComputeWorkerClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: 'contract-token',
    });
    const documentId = 'b'.repeat(64);
    const request = {
      documentId,
      namespace: null,
      documentObjectKey: `openreader/${documentId}.pdf`,
    };

    const created = await client.createPdfLayoutOperation(request);
    expect(created).toMatchObject({
      subject: { kind: 'pdf_layout', documentId, namespace: null },
      status: 'queued',
    });
    expect(created).not.toHaveProperty('opKey');
    expect(created).not.toHaveProperty('jobId');

    await expect(client.getOperation(created.opId)).resolves.toMatchObject({
      opId: created.opId,
      subject: { kind: 'pdf_layout', documentId, namespace: null },
    });
    await expect(client.resolvePdfLayout(request)).resolves.toMatchObject({
      artifact: null,
      operation: { opId: created.opId },
    });
  });
});

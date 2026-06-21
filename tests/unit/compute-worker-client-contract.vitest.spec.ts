import { afterEach, describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createComputeWorkerApp, type ComputeWorkerApp } from '../../packages/compute-worker/src/api/app';
import { FakeControlPlane } from '../../packages/compute-worker/tests/fixtures/fake-control-plane';
import { ComputeWorkerClient } from '../../src/lib/server/compute-worker/client';

const root = path.resolve(import.meta.dirname, '../..');
const workerSrcRoot = path.join(root, 'packages/compute-worker/src');

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry)) {
      files.push(fullPath);
    }
  }
  return files;
}

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

  test('keeps compute-worker source independent from app server modules', () => {
    for (const file of collectSourceFiles(workerSrcRoot)) {
      const source = readFileSync(file, 'utf8');
      expect(source, path.relative(root, file)).not.toMatch(/from ['"].*src\/lib\/server\//);
      expect(source, path.relative(root, file)).not.toMatch(/from ['"].*src\/app\//);
    }
  });

  test('keeps worker database dependency compatible with ESM execution', () => {
    const databaseEntry = readFileSync(path.join(root, 'packages/database/src/index.ts'), 'utf8');
    expect(databaseEntry).toContain("import { createRequire } from 'node:module'");
    expect(databaseEntry).toContain('createRequire(import.meta.url)');
  });
});

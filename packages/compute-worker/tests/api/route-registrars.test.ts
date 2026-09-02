import Fastify from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { registerHealthRoutes } from '../../src/api/routes/health';
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
});

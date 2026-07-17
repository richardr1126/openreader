import type { ComputeWorkerRouteContext } from '../route-context';

export function registerHealthRoutes({ app, getNatsConnected }: ComputeWorkerRouteContext): void {
  app.get('/health/live', {
    schema: {
      security: [],
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } },
    },
  }, async () => ({ ok: true }));

  app.get('/health/ready', {
    schema: {
      security: [],
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, natsConnected: { type: 'boolean' } },
          required: ['ok', 'natsConnected'],
        },
      },
    },
  }, async () => ({ ok: true, natsConnected: getNatsConnected() }));
}

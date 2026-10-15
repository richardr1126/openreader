import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAdminContext: vi.fn(),
  client: {
    getModelStatus: vi.fn(),
    createModelDownloadOperation: vi.fn(),
    cancelModelDownload: vi.fn(),
    removeModel: vi.fn(),
    getOperation: vi.fn(),
  },
  conflict: vi.fn(() => false),
  unavailable: vi.fn(() => false),
}));

vi.mock('@/lib/server/auth/admin', () => ({ requireAdminContext: mocks.requireAdminContext }));
vi.mock('@/lib/server/compute-worker/client', () => ({
  getComputeWorkerClient: () => mocks.client,
  isComputeWorkerConflictError: mocks.conflict,
  isComputeWorkerUnavailableError: mocks.unavailable,
}));

import { DELETE, GET, POST } from '../../src/app/api/admin/local-voices/route';
import { POST as CANCEL } from '../../src/app/api/admin/local-voices/cancel/route';
import { GET as EVENTS } from '../../src/app/api/admin/local-voices/events/route';

const request = (path = '/api/admin/local-voices', method = 'GET') =>
  new NextRequest(`http://localhost:3003${path}`, { method });

describe('admin local voices routes', () => {
  beforeEach(() => {
    mocks.requireAdminContext.mockReset().mockResolvedValue({ user: { id: 'admin' } });
    for (const fn of Object.values(mocks.client)) fn.mockReset();
    mocks.conflict.mockReset().mockReturnValue(false);
    mocks.unavailable.mockReset().mockReturnValue(false);
  });

  test('only admins reach the worker', async () => {
    mocks.requireAdminContext.mockResolvedValue(new Response(null, { status: 403 }));
    for (const response of [await GET(request()), await POST(request()), await DELETE(request()), await CANCEL(request())]) {
      expect(response.status).toBe(403);
    }
    for (const fn of Object.values(mocks.client)) expect(fn).not.toHaveBeenCalled();
  });

  test('reports status, starts the download and removes Kokoro', async () => {
    mocks.client.getModelStatus.mockResolvedValue({ model: 'kokoro-82m', components: [], downloading: false, operation: null });
    mocks.client.createModelDownloadOperation.mockResolvedValue({ opId: 'op-1', status: 'queued' });

    expect(await (await GET(request())).json()).toMatchObject({ model: 'kokoro-82m' });
    expect(mocks.client.getModelStatus).toHaveBeenCalledWith('kokoro-82m');
    const started = await POST(request('/api/admin/local-voices', 'POST'));
    expect(started.status).toBe(202);
    expect(await started.json()).toEqual({ operation: { opId: 'op-1', status: 'queued' } });
    expect((await DELETE(request('/api/admin/local-voices', 'DELETE'))).status).toBe(204);
    expect(mocks.client.removeModel).toHaveBeenCalledWith('kokoro-82m');
  });

  test('refuses to remove Kokoro while it downloads, and names an unreachable worker', async () => {
    mocks.client.removeModel.mockRejectedValue(new Error('409'));
    mocks.conflict.mockReturnValue(true);
    expect((await DELETE(request('/api/admin/local-voices', 'DELETE'))).status).toBe(409);

    mocks.client.getModelStatus.mockRejectedValue(new TypeError('fetch failed'));
    mocks.unavailable.mockReturnValue(true);
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'The compute worker is not reachable right now.' });
  });

  test('streams only model download operations', async () => {
    mocks.client.getOperation.mockResolvedValue({ opId: 'op-2', subject: { kind: 'email_delivery', deliveryId: 'd' } });
    expect((await EVENTS(request('/api/admin/local-voices/events?opId=op-2'))).status).toBe(404);
    expect((await EVENTS(request('/api/admin/local-voices/events'))).status).toBe(400);
  });
});

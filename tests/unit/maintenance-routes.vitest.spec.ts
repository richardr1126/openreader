import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), operation: vi.fn(), proxy: vi.fn(), step: vi.fn() }));
vi.mock('@/lib/server/auth/admin', () => ({ requireAdminContext: mocks.admin }));
vi.mock('@/lib/server/compute-worker/client', () => ({ getComputeWorkerClient: () => ({ getOperation: mocks.operation }) }));
vi.mock('@/lib/server/compute-worker/operation-events-proxy', () => ({ proxyOperationEvents: mocks.proxy }));
vi.mock('@/lib/server/tasks/maintenance-control', () => ({ executeMaintenanceStep: mocks.step, InvalidMaintenanceStep: class extends Error {} }));

import { GET } from '@/app/api/admin/maintenance/events/route';
import { POST } from '@/app/api/internal/compute/maintenance/route';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.admin.mockResolvedValue({ userId: 'owner' });
  vi.stubEnv('COMPUTE_CREDENTIAL_BROKER_TOKEN', 'test-maintenance-broker');
});
afterEach(() => vi.unstubAllEnvs());

describe('maintenance authentication and progress', () => {
  test('requires an administrator before reading any operation', async () => {
    const denied = new Response('Forbidden', { status: 403 });
    mocks.admin.mockResolvedValue(denied);
    expect(await GET(new NextRequest('http://localhost/api/admin/maintenance/events?opId=op'))).toBe(denied);
    expect(mocks.operation).not.toHaveBeenCalled();
  });
  test('does not expose other operation kinds through the admin cleanup stream', async () => {
    mocks.operation.mockResolvedValue({ subject: { kind: 'account_export' } });
    expect((await GET(new NextRequest('http://localhost/api/admin/maintenance/events?opId=op'))).status).toBe(403);
    expect(mocks.proxy).not.toHaveBeenCalled();
  });
  test('ends tracking for expired operation state instead of reconnecting forever', async () => {
    mocks.operation.mockResolvedValue(null);
    const response = await GET(new NextRequest('http://localhost/api/admin/maintenance/events?opId=expired'));
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toContain('event: unavailable');
  });
  test('database completion requires the separate worker-to-app broker token', async () => {
    const request = (authorization: string) => new NextRequest('http://localhost/api/internal/compute/maintenance', {
      method: 'POST', headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'finalize-user', userId: 'target' }),
    });
    expect((await POST(request('Bearer wrong-token'))).status).toBe(401);
    expect(mocks.step).not.toHaveBeenCalled();
    mocks.step.mockResolvedValue({ ok: true });
    expect((await POST(request('Bearer test-maintenance-broker'))).status).toBe(200);
    expect(mocks.step).toHaveBeenCalledWith({ action: 'finalize-user', userId: 'target' });
  });
});

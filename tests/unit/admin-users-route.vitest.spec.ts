import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAdminContext: vi.fn(),
  listAdminUsers: vi.fn(),
  updateManagedUser: vi.fn(),
  requestManagedUserDeletions: vi.fn(),
  createMaintenanceOperation: vi.fn(),
  isComputeWorkerAvailable: vi.fn(() => true),
}));

vi.mock('@/lib/server/auth/admin', () => ({ requireAdminContext: mocks.requireAdminContext }));
vi.mock('@/lib/server/admin/users', () => ({
  AdminUserManagementError: class AdminUserManagementError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
  listAdminUsers: mocks.listAdminUsers,
  updateManagedUser: mocks.updateManagedUser,
  requestManagedUserDeletions: mocks.requestManagedUserDeletions,
}));
vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: mocks.isComputeWorkerAvailable,
  getComputeWorkerClient: () => ({ createMaintenanceOperation: mocks.createMaintenanceOperation }),
}));

import { GET } from '../../src/app/api/admin/users/route';
import { PATCH } from '../../src/app/api/admin/users/[id]/route';
import { POST } from '../../src/app/api/admin/users/delete/route';

const request = (method: string, body?: unknown) => new NextRequest('http://localhost/api/admin/users/reader-1', {
  method,
  ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});
const params = { params: Promise.resolve({ id: 'reader-1' }) };

describe('admin users routes', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.requireAdminContext.mockResolvedValue({ userId: 'owner-1' });
    mocks.listAdminUsers.mockResolvedValue({ users: [], total: 0 });
    mocks.updateManagedUser.mockResolvedValue(undefined);
    mocks.requestManagedUserDeletions.mockResolvedValue(['reader-1']);
    mocks.isComputeWorkerAvailable.mockReturnValue(true);
    mocks.createMaintenanceOperation.mockResolvedValue({ opId: 'cleanup-1', status: 'queued' });
  });

  test('requires admin access before reading users', async () => {
    const denied = new Response('Forbidden', { status: 403 });
    mocks.requireAdminContext.mockResolvedValue(denied);
    expect(await GET(request('GET'))).toBe(denied);
    expect(mocks.listAdminUsers).not.toHaveBeenCalled();
  });

  test('validates paging and filters before listing', async () => {
    expect((await GET(new NextRequest('http://localhost/api/admin/users?page=0'))).status).toBe(400);
    expect((await GET(new NextRequest('http://localhost/api/admin/users?status=owner'))).status).toBe(400);
    expect(mocks.listAdminUsers).not.toHaveBeenCalled();

    const response = await GET(new NextRequest('http://localhost/api/admin/users?kind=anonymous&search=reader&page=2'));
    expect(response.status).toBe(200);
    expect(mocks.listAdminUsers).toHaveBeenCalledWith(expect.objectContaining({
      page: 2, kind: 'anonymous', search: 'reader',
    }));
  });

  test('rejects unknown or invalid mutation fields', async () => {
    expect((await PATCH(request('PATCH', { isAdmin: true, password: 'ignored' }), params)).status).toBe(400);
    expect((await PATCH(request('PATCH', { accessStatus: 'owner' }), params)).status).toBe(400);
    expect(mocks.updateManagedUser).not.toHaveBeenCalled();
  });

  test('passes the authenticated actor and target to the service', async () => {
    expect((await PATCH(request('PATCH', { accessStatus: 'active' }), params)).status).toBe(200);
    expect(mocks.updateManagedUser).toHaveBeenCalledWith({
      actorUserId: 'owner-1', targetUserId: 'reader-1', accessStatus: 'active',
    });
    const deletion = await POST(request('POST', { userIds: ['reader-1'] }));
    expect(deletion.status).toBe(202);
    expect(mocks.requestManagedUserDeletions).toHaveBeenCalledWith('owner-1', ['reader-1']);
    expect(mocks.createMaintenanceOperation).toHaveBeenCalledWith(expect.objectContaining({ task: 'delete-users', userIds: ['reader-1'] }));
  });

  test('requires admin access before deleting', async () => {
    const denied = new Response('Forbidden', { status: 403 });
    mocks.requireAdminContext.mockResolvedValue(denied);
    expect(await POST(request('POST', { userIds: ['reader-1'] }))).toBe(denied);
    expect(mocks.requestManagedUserDeletions).not.toHaveBeenCalled();
  });

  test('rejects oversized batches and unavailable workers before marking accounts', async () => {
    expect((await POST(request('POST', { userIds: Array(101).fill('reader-1') }))).status).toBe(400);
    mocks.isComputeWorkerAvailable.mockReturnValue(false);
    expect((await POST(request('POST', { userIds: ['reader-1'] }))).status).toBe(503);
    expect(mocks.requestManagedUserDeletions).not.toHaveBeenCalled();
  });
});

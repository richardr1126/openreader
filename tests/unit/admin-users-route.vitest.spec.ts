import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireAdminContext: vi.fn(),
  listAdminUsers: vi.fn(),
  updateManagedUser: vi.fn(),
  deleteManagedUser: vi.fn(),
}));

vi.mock('@/lib/server/auth/admin', () => ({ requireAdminContext: mocks.requireAdminContext }));
vi.mock('@/lib/server/admin/users', () => ({
  AdminUserManagementError: class AdminUserManagementError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
  listAdminUsers: mocks.listAdminUsers,
  updateManagedUser: mocks.updateManagedUser,
  deleteManagedUser: mocks.deleteManagedUser,
}));

import { GET } from '../../src/app/api/admin/users/route';
import { PATCH, DELETE } from '../../src/app/api/admin/users/[id]/route';

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
    mocks.deleteManagedUser.mockResolvedValue(undefined);
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
    expect((await DELETE(request('DELETE'), params)).status).toBe(200);
    expect(mocks.deleteManagedUser).toHaveBeenCalledWith({ actorUserId: 'owner-1', targetUserId: 'reader-1' });
  });

  test('requires admin access before deleting', async () => {
    const denied = new Response('Forbidden', { status: 403 });
    mocks.requireAdminContext.mockResolvedValue(denied);
    expect(await DELETE(request('DELETE'), params)).toBe(denied);
    expect(mocks.deleteManagedUser).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  markUsersForDeletion: vi.fn(),
  queueUserDeletion: vi.fn(),
  isComputeWorkerAvailable: vi.fn(() => true),
}));

vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('@/lib/server/auth/auth', () => ({
  getAuth: async () => ({ api: { getSession: mocks.getSession } }),
}));
vi.mock('@/lib/server/admin/users', () => ({
  AdminUserManagementError: class AdminUserManagementError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
  markUsersForDeletion: mocks.markUsersForDeletion,
}));
vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: mocks.isComputeWorkerAvailable,
}));
vi.mock('@/lib/server/tasks/enqueue-maintenance', () => ({
  queueUserDeletion: mocks.queueUserDeletion,
}));

import { AdminUserManagementError } from '@/lib/server/admin/users';
import { DELETE } from '../../src/app/api/account/delete/route';

describe('account delete route', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getSession.mockResolvedValue({ user: { id: 'reader-1' } });
    mocks.isComputeWorkerAvailable.mockReturnValue(true);
    mocks.markUsersForDeletion.mockResolvedValue(['reader-1']);
    mocks.queueUserDeletion.mockResolvedValue({ opId: 'op-1', status: 'queued' });
  });

  test('marks the account and queues the durable deletion job', async () => {
    const response = await DELETE();

    expect(response.status).toBe(202);
    expect(mocks.markUsersForDeletion).toHaveBeenCalledWith(['reader-1']);
    expect(mocks.queueUserDeletion).toHaveBeenCalledWith(['reader-1']);
  });

  test('requires a session and a compute worker before marking', async () => {
    mocks.getSession.mockResolvedValueOnce(null);
    expect((await DELETE()).status).toBe(401);

    mocks.isComputeWorkerAvailable.mockReturnValueOnce(false);
    expect((await DELETE()).status).toBe(503);

    expect(mocks.markUsersForDeletion).not.toHaveBeenCalled();
  });

  test('keeps the last admin from deleting their account', async () => {
    mocks.markUsersForDeletion.mockRejectedValueOnce(new AdminUserManagementError('Keep at least one admin.', 409));

    expect((await DELETE()).status).toBe(409);
    expect(mocks.queueUserDeletion).not.toHaveBeenCalled();
  });

  test('accepts a marked account whose queueing failed, leaving the retry to pending deletions', async () => {
    mocks.queueUserDeletion.mockRejectedValueOnce(new Error('worker busy'));

    expect((await DELETE()).status).toBe(202);
  });
});

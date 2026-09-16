import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectedRows: [] as unknown[][],
  update: vi.fn(),
  remove: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock('@openreader/database', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(mocks.selectedRows.shift() ?? []),
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(mocks.selectedRows.shift() ?? []).then(resolve),
        }),
      }),
    }),
    update: (...args: unknown[]) => {
      mocks.update(...args);
      return { set: () => ({ where: () => Promise.resolve() }) };
    },
    delete: (...args: unknown[]) => {
      mocks.remove(...args);
      return { where: () => Promise.resolve() };
    },
  },
}));
vi.mock('@/lib/server/user/data-cleanup', () => ({ deleteUserStorageData: mocks.cleanup }));

import { deleteManagedUser, updateManagedUser } from '../../src/lib/server/admin/users';

function target(overrides: Record<string, unknown> = {}) {
  return { id: 'target-1', email: 'reader@example.test', isAnonymous: false, isAdmin: false, adminSource: 'none', accessStatus: 'active', ...overrides };
}

describe('admin user mutation guards', () => {
  beforeEach(() => {
    mocks.selectedRows = [];
    mocks.update.mockReset();
    mocks.remove.mockReset();
    mocks.cleanup.mockReset();
    mocks.cleanup.mockResolvedValue(undefined);
  });

  test('does not grant a role to anonymous users', async () => {
    mocks.selectedRows = [[target({ isAnonymous: true })]];
    await expect(updateManagedUser({ actorUserId: 'owner', targetUserId: 'target-1', isAdmin: true }))
      .rejects.toThrow(/anonymous users/i);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  test('does not grant a role and suspend in the same request', async () => {
    mocks.selectedRows = [[target()]];
    await expect(updateManagedUser({
      actorUserId: 'owner', targetUserId: 'target-1', isAdmin: true, accessStatus: 'suspended',
    })).rejects.toThrow(/approve or restore/i);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  test('prevents self-demotion and deleting the last administrator', async () => {
    mocks.selectedRows = [[target({ isAdmin: true })]];
    await expect(updateManagedUser({ actorUserId: 'target-1', targetUserId: 'target-1', isAdmin: false }))
      .rejects.toThrow(/own administrator access/i);

    mocks.selectedRows = [[target({ isAdmin: true })], [{ value: 1 }]];
    await expect(deleteManagedUser({ actorUserId: 'owner', targetUserId: 'target-1' }))
      .rejects.toThrow(/final administrator/i);
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  test('never deletes the account when storage cleanup fails', async () => {
    mocks.selectedRows = [[target()]];
    mocks.cleanup.mockRejectedValue(new Error('storage unavailable'));
    await expect(deleteManagedUser({ actorUserId: 'owner', targetUserId: 'target-1' }))
      .rejects.toThrow(/storage unavailable/);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  test('revokes sessions after an approval', async () => {
    mocks.selectedRows = [[target({ accessStatus: 'pending' })]];
    await updateManagedUser({ actorUserId: 'owner', targetUserId: 'target-1', accessStatus: 'active' });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});

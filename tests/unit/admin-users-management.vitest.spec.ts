import { beforeEach, describe, expect, test, vi } from 'vitest';
import { user } from '../../packages/database/src/schema_auth_sqlite';

const mocks = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = {
    selectedRows: [] as unknown[][],
    update: vi.fn(),
    remove: vi.fn(),
    cleanup: vi.fn(),
  };
  // One connection object backs both the plain `db` handle and the transaction
  // connection passed to `runInDbTransaction`, so both share `selectedRows`.
  m.conn = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(m.selectedRows.shift() ?? []),
          then: (resolve: (rows: unknown[]) => unknown) =>
            Promise.resolve(m.selectedRows.shift() ?? []).then(resolve),
        }),
      }),
    }),
    update: (...args: unknown[]) => {
      m.update(...args);
      return { set: () => ({ where: () => Promise.resolve() }) };
    },
    delete: (...args: unknown[]) => {
      m.remove(...args);
      return { where: () => Promise.resolve() };
    },
    execute: () => Promise.resolve(),
  };
  return m;
});

vi.mock('@openreader/database', () => ({ db: mocks.conn }));
vi.mock('@openreader/database/run-in-transaction', () => ({
  runInDbTransaction: (fn: (conn: unknown) => unknown) => fn(mocks.conn),
}));
vi.mock('@/lib/server/user/data-cleanup', () => ({ deleteUserDatabaseData: mocks.cleanup }));

import {
  requestManagedUserDeletions,
  finalizeUserDeletion,
  updateManagedUser,
} from '../../src/lib/server/admin/users';

function target(overrides: Record<string, unknown> = {}) {
  return { id: 'target-1', email: 'reader@example.test', isAnonymous: false, isAdmin: false, adminSource: 'none', accessStatus: 'active', ...overrides };
}

// Did phase 2 remove the account row (as opposed to only revoking sessions)?
function userRowDeleted(): boolean {
  return mocks.remove.mock.calls.some((call: unknown[]) => call[0] === user);
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
    await expect(requestManagedUserDeletions('owner', ['target-1']))
      .rejects.toThrow(/final administrator/i);
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  test('marks the batch and revokes sessions without waiting for storage or removing rows', async () => {
    mocks.selectedRows = [[target()]];
    await expect(requestManagedUserDeletions('owner', ['target-1'])).resolves.toEqual(['target-1']);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(userRowDeleted()).toBe(false);
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  test('refuses a worker completion for an account that was not marked', async () => {
    mocks.selectedRows = [[target()]];
    await expect(finalizeUserDeletion('target-1')).rejects.toThrow(/not marked/);
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(userRowDeleted()).toBe(false);
  });

  test('completes only marked deletions and preserves rows if SQL cleanup fails', async () => {
    mocks.selectedRows = [[target({ deletionRequestedAt: new Date() })]];
    mocks.cleanup.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(finalizeUserDeletion('target-1')).rejects.toThrow(/database unavailable/);
    expect(userRowDeleted()).toBe(false);
    mocks.selectedRows = [[target({ deletionRequestedAt: new Date() })]];
    await finalizeUserDeletion('target-1');
    expect(userRowDeleted()).toBe(true);
  });

  test('prevents restoring an account whose deletion has started', async () => {
    mocks.selectedRows = [[target({ deletionRequestedAt: new Date() })]];
    await expect(updateManagedUser({ actorUserId: 'owner', targetUserId: 'target-1', accessStatus: 'active' }))
      .rejects.toThrow(/being deleted/);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  test('revokes sessions after an approval', async () => {
    mocks.selectedRows = [[target({ accessStatus: 'pending' })]];
    await updateManagedUser({ actorUserId: 'owner', targetUserId: 'target-1', accessStatus: 'active' });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});

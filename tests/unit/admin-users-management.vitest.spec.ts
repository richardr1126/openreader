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
vi.mock('@/lib/server/user/data-cleanup', () => ({ deleteUserStorageData: mocks.cleanup }));

import {
  deleteManagedUser,
  resumePendingUserDeletions,
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
    await expect(deleteManagedUser({ actorUserId: 'owner', targetUserId: 'target-1' }))
      .rejects.toThrow(/final administrator/i);
    expect(mocks.cleanup).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  test('durably suspends and marks before cleaning up storage and the row', async () => {
    mocks.selectedRows = [[target()]];
    await deleteManagedUser({ actorUserId: 'owner', targetUserId: 'target-1' });
    // Phase 1 wrote the suspend + deletionRequestedAt marker...
    expect(mocks.update).toHaveBeenCalledTimes(1);
    // ...and phase 2 cleaned up storage then removed the row.
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    expect(userRowDeleted()).toBe(true);
  });

  test('never deletes the account row when storage cleanup fails', async () => {
    mocks.selectedRows = [[target()]];
    mocks.cleanup.mockRejectedValue(new Error('storage unavailable'));
    await expect(deleteManagedUser({ actorUserId: 'owner', targetUserId: 'target-1' }))
      .rejects.toThrow(/storage unavailable/);
    // The durable marker was written and sessions revoked, but the irreversible
    // row deletion never ran — a later sweep can retry it.
    expect(userRowDeleted()).toBe(false);
  });

  test('resume sweep finishes durably marked deletions', async () => {
    mocks.selectedRows = [[{ id: 'u1' }, { id: 'u2' }]];
    await resumePendingUserDeletions();
    expect(mocks.cleanup).toHaveBeenCalledTimes(2);
    expect(mocks.remove.mock.calls.filter((call: unknown[]) => call[0] === user)).toHaveLength(2);
  });

  test('revokes sessions after an approval', async () => {
    mocks.selectedRows = [[target({ accessStatus: 'pending' })]];
    await updateManagedUser({ actorUserId: 'owner', targetUserId: 'target-1', accessStatus: 'active' });
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});

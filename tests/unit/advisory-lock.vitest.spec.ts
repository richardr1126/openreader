import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeEach, expect, test, vi } from 'vitest';
import { AdvisoryLockBusyError, withPostgresAdvisoryLock } from '@openreader/database/advisory-lock';

// The lock loads pg with require, as the database package does, so vi.mock cannot reach it.
const { Pool } = createRequire(path.resolve('packages/database/package.json'))('pg');
const mock = { connect: vi.spyOn(Pool.prototype, 'connect'), query: vi.fn(), release: vi.fn() };
afterAll(() => mock.connect.mockRestore());

const statements = () => mock.query.mock.calls.map(([statement]) => String(statement));

beforeEach(() => {
  mock.release.mockClear();
  mock.query.mockReset().mockResolvedValue({ rows: [] });
  mock.connect.mockReset().mockResolvedValue({ query: mock.query, release: mock.release, on: vi.fn(), off: vi.fn() });
});

test('holds the lock only around the work, on its own connection', async () => {
  const work = vi.fn(async () => {
    expect(statements().some(statement => statement.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(statements()).not.toContain('ROLLBACK');
    return 'done';
  });

  await expect(withPostgresAdvisoryLock('key', work)).resolves.toBe('done');

  expect(statements()[0]).toBe('BEGIN');
  expect(statements().at(-1)).toBe('ROLLBACK');
  expect(mock.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['key']);
  expect(mock.release).toHaveBeenCalledWith(false);
});

test('releases the lock when the work fails, and reports that failure', async () => {
  await expect(withPostgresAdvisoryLock('key', async () => { throw new Error('work failed'); })).rejects.toThrow('work failed');
  expect(statements().at(-1)).toBe('ROLLBACK');
  expect(mock.release).toHaveBeenCalledWith(false);
});

test('a lock wait that times out is reported as busy without running the work', async () => {
  mock.query.mockImplementation(async (statement: string) => {
    if (statement.includes('pg_advisory_xact_lock')) throw Object.assign(new Error('timeout'), { code: '55P03' });
    return { rows: [] };
  });
  const work = vi.fn();

  await expect(withPostgresAdvisoryLock('key', work)).rejects.toBeInstanceOf(AdvisoryLockBusyError);
  expect(work).not.toHaveBeenCalled();
  expect(mock.release).toHaveBeenCalledWith(false);
});

test('no connection in time is reported as busy', async () => {
  mock.connect.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
  await expect(withPostgresAdvisoryLock('key', vi.fn())).rejects.toBeInstanceOf(AdvisoryLockBusyError);
});

test('a connection that cannot roll back is discarded rather than reused', async () => {
  mock.query.mockImplementation(async (statement: string) => {
    if (statement === 'ROLLBACK') throw new Error('connection lost');
    return { rows: [] };
  });
  await expect(withPostgresAdvisoryLock('key', async () => 'done')).resolves.toBe('done');
  expect(mock.release).toHaveBeenCalledWith(true);
});

test('other database errors are not disguised as busy', async () => {
  mock.query.mockImplementation(async (statement: string) => {
    if (statement.includes('pg_advisory_xact_lock')) throw Object.assign(new Error('denied'), { code: '42501' });
    return { rows: [] };
  });
  await expect(withPostgresAdvisoryLock('key', vi.fn())).rejects.toThrow('denied');
});

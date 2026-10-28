import { beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as sqliteSchema from '@openreader/database/schema-sqlite';

// Real in-memory SQLite so the re-arm, settle and backoff predicates run as SQL.
const holder = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof drizzle> }));
const mocks = vi.hoisted(() => ({
  workerAvailable: true,
  cleanupUserStorage: vi.fn(async () => undefined),
  deleteDocumentTtsSegmentCache: vi.fn(async () => undefined),
}));

vi.mock('@openreader/database', () => ({
  get db() {
    return holder.db;
  },
}));

vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: () => mocks.workerAvailable,
  getComputeWorkerClient: () => ({ cleanupUserStorage: mocks.cleanupUserStorage }),
}));

vi.mock('@/lib/server/tts/segments-cache', () => ({
  deleteDocumentTtsSegmentCache: mocks.deleteDocumentTtsSegmentCache,
}));

vi.mock('@/lib/server/errors/logging', () => ({ logDegraded: vi.fn() }));

import {
  drainStorageCleanups,
  enqueueStorageCleanup,
  runStorageCleanup,
} from '../../src/lib/server/storage/cleanups';

const SCHEMA = `
CREATE TABLE user (id text PRIMARY KEY NOT NULL);
CREATE TABLE documents (id text NOT NULL, user_id text NOT NULL, PRIMARY KEY (id, user_id));
CREATE TABLE storage_cleanups (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL,
  document_id text,
  not_before_ms integer NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  last_error text,
  created_at_ms integer NOT NULL
);`;

let sqlite: Database.Database;

function queuedRows() {
  return sqlite.prepare('SELECT id, attempts, not_before_ms AS notBeforeMs, last_error AS lastError FROM storage_cleanups ORDER BY id')
    .all() as Array<{ id: string; attempts: number; notBeforeMs: number; lastError: string | null }>;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.exec(SCHEMA);
  holder.db = drizzle(sqlite, { schema: sqliteSchema });
  mocks.workerAvailable = true;
  mocks.cleanupUserStorage.mockReset();
  mocks.cleanupUserStorage.mockResolvedValue(undefined);
  mocks.deleteDocumentTtsSegmentCache.mockReset();
  mocks.deleteDocumentTtsSegmentCache.mockResolvedValue(undefined);
});

describe('storage cleanup queue', () => {
  test('clears a deleted document and removes its row', async () => {
    const row = await enqueueStorageCleanup({ userId: 'u1', documentId: 'd1' });

    await expect(runStorageCleanup(row)).resolves.toBe('cleared');

    expect(mocks.deleteDocumentTtsSegmentCache).toHaveBeenCalledWith({ userId: 'u1', documentId: 'd1', namespace: null });
    expect(queuedRows()).toEqual([]);
  });

  test('drops the row without touching storage when the document is owned again', async () => {
    sqlite.exec(`INSERT INTO documents (id, user_id) VALUES ('d1', 'u1')`);
    const row = await enqueueStorageCleanup({ userId: 'u1', documentId: 'd1' });

    await expect(runStorageCleanup(row)).resolves.toBe('owned');

    expect(mocks.deleteDocumentTtsSegmentCache).not.toHaveBeenCalled();
    expect(queuedRows()).toEqual([]);
  });

  test('backs a failed cleanup off and clears it on a later attempt', async () => {
    mocks.cleanupUserStorage.mockRejectedValueOnce(new Error('worker down'));
    const row = await enqueueStorageCleanup({ userId: 'gone', documentId: null });

    const before = Date.now();
    await expect(runStorageCleanup(row)).resolves.toBe('failed');
    const [failed] = queuedRows();
    expect(failed).toEqual(expect.objectContaining({ id: 'user:gone', attempts: 1 }));
    expect(failed.lastError).toContain('worker down');
    expect(failed.notBeforeMs).toBeGreaterThanOrEqual(before + 5 * 60 * 1000);

    await expect(runStorageCleanup({ ...row, attempts: 1, notBeforeMs: failed.notBeforeMs })).resolves.toBe('cleared');
    expect(mocks.cleanupUserStorage).toHaveBeenLastCalledWith({ storageUserId: 'gone', namespace: null, documentIds: [] });
    expect(queuedRows()).toEqual([]);
  });

  test('reports failure without rejecting when the backoff cannot be recorded', async () => {
    const row = await enqueueStorageCleanup({ userId: 'u1', documentId: 'd1' });
    mocks.deleteDocumentTtsSegmentCache.mockImplementationOnce(async () => {
      sqlite.close();
      throw new Error('worker down');
    });

    await expect(runStorageCleanup(row)).resolves.toBe('failed');
  });

  test('keeps a row re-armed while its earlier generation was running', async () => {
    const stale = await enqueueStorageCleanup({ userId: 'u1', documentId: 'd1', notBeforeMs: 1 });
    await enqueueStorageCleanup({ userId: 'u1', documentId: 'd1', notBeforeMs: 2 });

    await expect(runStorageCleanup(stale)).resolves.toBe('cleared');

    expect(queuedRows()).toEqual([expect.objectContaining({ id: 'doc:u1:d1', notBeforeMs: 2 })]);
  });

  test('drains only due rows and attempts each once per run', async () => {
    mocks.workerAvailable = false;
    await enqueueStorageCleanup({ userId: 'u1', documentId: 'due' });
    await enqueueStorageCleanup({ userId: 'u1', documentId: 'later', notBeforeMs: Date.now() + 60_000 });

    const result = await drainStorageCleanups({ deadlineAt: Date.now() + 10_000 });

    expect(result).toEqual({ cleared: 0, owned: 0, failed: 1, remaining: false });
    expect(queuedRows().map((row) => [row.id, row.attempts])).toEqual([
      ['doc:u1:due', 1],
      ['doc:u1:later', 0],
    ]);
  });
});

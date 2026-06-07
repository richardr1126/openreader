import { beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as sqliteSchema from '../../src/db/schema_sqlite';

// Back the engine with a real in-memory SQLite so the CAS claim, due-detection,
// and nextRunAt arithmetic are exercised against real SQL rather than mocks.
const holder = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof drizzle> }));
vi.mock('@/db', () => ({
  get db() {
    return holder.db;
  },
}));

// Keep the error-path test from printing the expected failure to the console.
vi.mock('@/lib/server/errors/logging', () => ({ logDegraded: vi.fn() }));

import { runDueTasks } from '../../src/lib/server/tasks/engine';
import type { TaskRegistry } from '../../src/lib/server/tasks/types';

const tasks = sqliteSchema.scheduledTasks;

const CREATE_TABLE = `CREATE TABLE scheduled_tasks (
  key text PRIMARY KEY NOT NULL,
  enabled integer DEFAULT true NOT NULL,
  interval_ms integer NOT NULL,
  last_status text DEFAULT 'idle' NOT NULL,
  last_run_at integer,
  last_duration_ms integer,
  last_error text,
  last_result_json text,
  next_run_at integer,
  run_requested integer DEFAULT false NOT NULL,
  running_since integer,
  updated_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);`;

const KEY = 'test-task';

async function seedRow(overrides: Partial<typeof tasks.$inferInsert>) {
  await holder.db.insert(tasks).values({
    key: KEY,
    enabled: true,
    intervalMs: 1000,
    lastStatus: 'idle',
    nextRunAt: Date.now() - 1,
    runRequested: false,
    ...overrides,
  });
}

async function readRow() {
  const rows = await holder.db.select().from(tasks).where(eq(tasks.key, KEY));
  return rows[0];
}

function registryWith(run: () => Promise<{ summary?: string } | void>): TaskRegistry {
  return { [KEY]: { name: 'Test task', defaultIntervalMs: 1000, run } };
}

beforeEach(() => {
  const sqlite = new Database(':memory:');
  sqlite.exec(CREATE_TABLE);
  holder.db = drizzle(sqlite, { schema: sqliteSchema });
});

describe('scheduled task engine', () => {
  test('runs a due task and records success + next run', async () => {
    const handler = vi.fn(async () => ({ summary: 'did 3 things' }));
    await seedRow({ nextRunAt: Date.now() - 1 });

    await runDueTasks({ registry: registryWith(handler) });

    expect(handler).toHaveBeenCalledTimes(1);
    const row = await readRow();
    expect(row.lastStatus).toBe('ok');
    expect(row.lastRunAt).not.toBeNull();
    expect(row.lastResultJson).toBe('did 3 things');
    expect(row.runningSince).toBeNull();
    expect(Number(row.nextRunAt)).toBeGreaterThan(Date.now());
  });

  test('does not run a task that is not yet due', async () => {
    const handler = vi.fn(async () => undefined);
    await seedRow({ nextRunAt: Date.now() + 60_000, lastStatus: 'idle' });

    await runDueTasks({ registry: registryWith(handler) });

    expect(handler).not.toHaveBeenCalled();
    expect((await readRow()).lastStatus).toBe('idle');
  });

  test('runs when a manual run is requested even if not due', async () => {
    const handler = vi.fn(async () => ({ summary: 'manual' }));
    await seedRow({ nextRunAt: Date.now() + 60_000, runRequested: true });

    await runDueTasks({ registry: registryWith(handler) });

    expect(handler).toHaveBeenCalledTimes(1);
    const row = await readRow();
    expect(row.lastStatus).toBe('ok');
    expect(row.runRequested).toBe(false);
  });

  test('records errors without throwing', async () => {
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    await seedRow({ nextRunAt: Date.now() - 1 });

    await expect(runDueTasks({ registry: registryWith(handler) })).resolves.toBeUndefined();

    const row = await readRow();
    expect(row.lastStatus).toBe('error');
    expect(row.lastError).toContain('boom');
  });

  test('single-flight: skips a task already marked running', async () => {
    const handler = vi.fn(async () => undefined);
    await seedRow({ nextRunAt: Date.now() - 1, lastStatus: 'running', runningSince: Date.now() });

    await runDueTasks({ registry: registryWith(handler) });

    expect(handler).not.toHaveBeenCalled();
    expect((await readRow()).lastStatus).toBe('running');
  });

  test('runs a requested task even when disabled', async () => {
    const handler = vi.fn(async () => undefined);
    await seedRow({ nextRunAt: Date.now() + 60_000, enabled: false, runRequested: true });

    await runDueTasks({ registry: registryWith(handler) });

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

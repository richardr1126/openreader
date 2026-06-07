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

import { runDueTasks, updateTask } from '../../src/lib/server/tasks/engine';
import type { TaskRegistry } from '../../src/lib/server/tasks/types';

const tasks = sqliteSchema.scheduledTasks;

const CREATE_TABLE = `CREATE TABLE scheduled_tasks (
  key text PRIMARY KEY NOT NULL,
  enabled integer DEFAULT true NOT NULL,
  interval_ms integer NOT NULL,
  last_status text DEFAULT 'idle' NOT NULL,
  lease_owner text,
  last_run_at integer,
  last_duration_ms integer,
  last_error text,
  last_result_json text,
  next_run_at integer,
  run_requested integer DEFAULT false NOT NULL,
  running_since integer,
  updated_at integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
  CONSTRAINT scheduled_tasks_interval_ms_positive CHECK(interval_ms > 0)
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

  test('preserves a manual rerun requested while a task is running', async () => {
    const handler = vi.fn(async () => {
      await holder.db
        .update(tasks)
        .set({ runRequested: true })
        .where(eq(tasks.key, KEY));
    });
    await seedRow({ nextRunAt: Date.now() - 1 });

    await runDueTasks({ registry: registryWith(handler) });

    expect(handler).toHaveBeenCalledTimes(1);
    expect((await readRow()).runRequested).toBe(true);
  });

  test('does not let a stale runner overwrite its replacement run', async () => {
    let resolveFirst!: (value: { summary: string }) => void;
    const firstResult = new Promise<{ summary: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const handler = vi.fn()
      .mockImplementationOnce(() => firstResult)
      .mockResolvedValueOnce({ summary: 'replacement' });
    await seedRow({ nextRunAt: Date.now() - 1 });

    let now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const firstRun = runDueTasks({ registry: registryWith(handler) });
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    now += 2 * 60 * 60 * 1000;
    await runDueTasks({ registry: registryWith(handler) });
    expect((await readRow()).lastResultJson).toBe('replacement');

    resolveFirst({ summary: 'stale original' });
    await firstRun;
    expect((await readRow()).lastResultJson).toBe('replacement');
    nowSpy.mockRestore();
  });

  test('starts independent due tasks concurrently', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry: TaskRegistry = {
      first: {
        name: 'First',
        defaultIntervalMs: 1000,
        run: async () => {
          started.push('first');
          await gate;
        },
      },
      second: {
        name: 'Second',
        defaultIntervalMs: 1000,
        run: async () => {
          started.push('second');
          await gate;
        },
      },
    };

    const running = runDueTasks({ registry });
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
    release();
    await running;
  });

  test('aborts and records an error when a task exceeds its runtime limit', async () => {
    const handler = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    await seedRow({ nextRunAt: Date.now() - 1 });
    const registry: TaskRegistry = {
      [KEY]: { name: 'Timed task', defaultIntervalMs: 1000, maxRunMs: 5, run: handler },
    };

    await runDueTasks({ registry });

    expect(handler).toHaveBeenCalledTimes(1);
    expect((await readRow()).lastError).toContain('runtime limit');
  });

  test('rejects non-positive intervals at the database boundary', async () => {
    await expect(seedRow({ intervalMs: 0 })).rejects.toThrow();
  });

  test('updates a registered task even when its row has not been seeded', async () => {
    await updateTask('prune-job-events', { enabled: false, intervalMs: 12_345 });

    const [row] = await holder.db
      .select()
      .from(tasks)
      .where(eq(tasks.key, 'prune-job-events'));
    expect(row).toEqual(expect.objectContaining({
      enabled: false,
      intervalMs: 12_345,
      lastStatus: 'idle',
    }));
  });
});

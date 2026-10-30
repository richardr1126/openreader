import { beforeEach, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as sqliteSchema from '@openreader/database/schema-sqlite';

// Back the engine with a real in-memory SQLite so the CAS claim, due-detection,
// and nextRunAt arithmetic are exercised against real SQL rather than mocks.
const holder = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof drizzle> }));
const worker = vi.hoisted(() => ({ getOperation: vi.fn() }));
vi.mock('@/lib/server/compute-worker/client', () => ({
  getComputeWorkerClient: () => worker,
}));
vi.mock('@openreader/database', () => ({
  get db() {
    return holder.db;
  },
}));

// Keep the error-path test from printing the expected failure to the console.
vi.mock('@/lib/server/errors/logging', () => ({ logDegraded: vi.fn() }));

import { listTasks, runDueTasks, updateTask } from '../../src/lib/server/tasks/engine';
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

function registryWith(run: TaskRegistry[string]['run']): TaskRegistry {
  return { [KEY]: { name: 'Test task', defaultIntervalMs: 1000, run } };
}

beforeEach(() => {
  worker.getOperation.mockReset();
  const sqlite = new Database(':memory:');
  sqlite.exec(CREATE_TABLE);
  holder.db = drizzle(sqlite, { schema: sqliteSchema });
});

describe('scheduled task engine', () => {
  test('keeps a queued worker task running until durable completion, including partial failure', async () => {
    let runId = '';
    const registry = registryWith(async (context) => {
      runId = context.runId;
      return { operationId: 'op-maintenance', summary: 'Queued' };
    });
    await runDueTasks({ registry });
    expect((await readRow()).lastStatus).toBe('running');
    worker.getOperation.mockResolvedValue({
      opId: 'op-maintenance', subject: { kind: 'maintenance', runId }, status: 'running', queuedAt: Date.now(),
    });
    expect((await listTasks(registry))[0]).toMatchObject({ operationId: 'op-maintenance', running: true });
    worker.getOperation.mockResolvedValue({
      opId: 'op-maintenance', subject: { kind: 'maintenance', runId }, status: 'succeeded', queuedAt: Date.now(),
      result: { summary: 'Deleted 20 accounts; 5 failed', completed: 20, failed: 5 },
    });
    expect((await listTasks(registry))[0]).toMatchObject({ running: false, lastStatus: 'error', lastError: 'Deleted 20 accounts; 5 failed' });
  });

  test('does not reclaim a long-running worker job or start another when its worker is unreachable', async () => {
    const handler = vi.fn(async () => ({ summary: 'wrong duplicate' }));
    const leaseOwner = 'existing-run';
    await seedRow({
      lastStatus: 'running', leaseOwner, runningSince: Date.now() - 7_200_000,
      lastResultJson: JSON.stringify({ operationId: 'op-existing' }),
    });
    worker.getOperation.mockRejectedValue(new Error('worker temporarily unavailable'));
    await runDueTasks({ registry: registryWith(handler) });
    expect(handler).not.toHaveBeenCalled();
    expect((await readRow()).lastStatus).toBe('running');
  });
  test('sequential mode claims every due task, then runs them one at a time', async () => {
    const events: string[] = [];
    const task = (key: string) => async () => {
      events.push(`${key}:start`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`${key}:end`);
      return { summary: key };
    };
    const registry: TaskRegistry = {
      a: { name: 'A', defaultIntervalMs: 1000, run: task('a') },
      b: { name: 'B', defaultIntervalMs: 1000, run: task('b') },
    };

    await runDueTasks({ registry, sequential: true });

    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    const rows = await holder.db.select().from(tasks);
    expect(rows.map((row) => row.lastStatus)).toEqual(['ok', 'ok']);
  });

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

  test('hands the stored cursor to the next run and shows only the summary', async () => {
    const handler = vi.fn()
      .mockResolvedValueOnce({ summary: 'first page', cursor: 'page-2' })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ summary: 'done' });
    const registry = registryWith(handler);
    await seedRow({ nextRunAt: Date.now() - 1 });

    await runDueTasks({ registry });
    expect((await listTasks(registry))[0].lastResult).toBe('first page');

    await holder.db.update(tasks).set({ runRequested: true }).where(eq(tasks.key, KEY));
    await runDueTasks({ registry });
    await holder.db.update(tasks).set({ runRequested: true }).where(eq(tasks.key, KEY));
    await runDueTasks({ registry });

    expect(handler.mock.calls.map(([context]) => context.cursor)).toEqual([null, 'page-2', 'page-2']);
    expect((await readRow()).lastResultJson).toBe('done');
  });

  test('a task can disable itself when its work is complete', async () => {
    await seedRow({ nextRunAt: Date.now() - 1 });

    await runDueTasks({ registry: registryWith(async () => ({ summary: 'finished', disableTask: true })) });

    const row = await readRow();
    expect(row.enabled).toBe(false);
    expect(row.lastStatus).toBe('ok');
  });

  test('seeds tasks registered as disabled by default', async () => {
    const registry: TaskRegistry = {
      [KEY]: { name: 'Opt-in task', defaultIntervalMs: 1000, defaultEnabled: false, run: vi.fn() },
    };

    expect((await listTasks(registry))[0].enabled).toBe(false);
  });

  test('keeps an opt-in task disabled when only its interval is edited', async () => {
    await updateTask('expire-anonymous-users', { intervalMs: 2000 });

    const [row] = await holder.db.select().from(tasks).where(eq(tasks.key, 'expire-anonymous-users'));
    expect(row.enabled).toBe(false);
  });

  test('rejects non-positive intervals at the database boundary', async () => {
    await expect(seedRow({ intervalMs: 0 })).rejects.toThrow();
  });

  test('updates a registered task even when its row has not been seeded', async () => {
    await updateTask('prune-compute-limits', { enabled: false, intervalMs: 12_345 });

    const [row] = await holder.db
      .select()
      .from(tasks)
      .where(eq(tasks.key, 'prune-compute-limits'));
    expect(row).toEqual(expect.objectContaining({
      enabled: false,
      intervalMs: 12_345,
      lastStatus: 'idle',
    }));
  });
});

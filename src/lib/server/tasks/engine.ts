import { randomUUID } from 'node:crypto';
import { and, eq, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '@openreader/database';
import { scheduledTasks } from '@openreader/database/schema';
import { serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';
import { TASK_REGISTRY } from './registry';
import type { TaskContext, TaskDef, TaskRegistry, TaskRunStatus } from './types';
import { getComputeWorkerClient } from '@/lib/server/compute-worker/client';
import type { MaintenanceResult } from '@/lib/server/compute-worker/protocol';

// A task still marked 'running' after this long is assumed abandoned (process
// crashed mid-run) and may be reclaimed by the next tick.
const STALE_RUNNING_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Next control-plane invocations must remain comfortably below Vercel's
// request ceiling. Handlers must observe the supplied AbortSignal so a future
// larger maintenance job is moved to the worker instead of stretching a route.
const DEFAULT_TASK_MAX_RUN_MS = 45_000;

/**
 * Seed a `scheduled_tasks` row for every registered task. Idempotent: existing
 * rows (including user-edited interval/enabled) are left untouched.
 */
async function ensureTaskRows(registry: TaskRegistry = TASK_REGISTRY): Promise<void> {
  const now = Date.now();
  const rows = Object.entries(registry).map(([key, def]) => ({
    key, enabled: def.defaultEnabled ?? true, intervalMs: def.defaultIntervalMs,
    lastStatus: 'idle', nextRunAt: now,
  }));
  if (rows.length) await db
      .insert(scheduledTasks)
      .values(rows)
      .onConflictDoNothing();
}

/**
 * Atomically claim a task for execution. Returns true only if this caller won
 * the claim. The single UPDATE flips status to 'running' iff it is not already
 * running (or its running marker is stale). A unique owner token fences final
 * state updates if a stale runner later completes after being replaced.
 */
async function claimTask(key: string, now: number): Promise<string | null> {
  const leaseOwner = randomUUID();
  const claimed = await db
    .update(scheduledTasks)
    .set({
      lastStatus: 'running',
      leaseOwner,
      runningSince: now,
      runRequested: false,
      updatedAt: now,
    })
    .where(and(
      eq(scheduledTasks.key, key),
      or(
        ne(scheduledTasks.lastStatus, 'running'),
        lt(scheduledTasks.runningSince, now - STALE_RUNNING_MS),
      ),
    ))
    .returning({ leaseOwner: scheduledTasks.leaseOwner });
  return claimed[0]?.leaseOwner === leaseOwner ? leaseOwner : null;
}

// `last_result_json` holds the plain summary, or `{summary, cursor}` while a
// bounded task has more to do.
function encodeStoredResult(summary: string | null, cursor: string | null, operationId: string | null = null): string | null {
  return cursor === null && operationId === null ? summary : JSON.stringify({ summary, cursor, operationId });
}

function decodeStoredResult(raw: string | null | undefined): { summary: string | null; cursor: string | null; operationId: string | null } {
  if (!raw) return { summary: null, cursor: null, operationId: null };
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as { summary?: unknown; cursor?: unknown; operationId?: unknown };
      if (typeof parsed.cursor === 'string' || typeof parsed.operationId === 'string') {
        return {
          summary: typeof parsed.summary === 'string' ? parsed.summary : null,
          cursor: typeof parsed.cursor === 'string' ? parsed.cursor : null,
          operationId: typeof parsed.operationId === 'string' ? parsed.operationId : null,
        };
      }
    } catch {
      // A plain summary that happens to start with a brace.
    }
  }
  return { summary: raw, cursor: null, operationId: null };
}

async function readTaskCursor(key: string): Promise<string | null> {
  const [row] = await db.select({ lastResultJson: scheduledTasks.lastResultJson })
    .from(scheduledTasks).where(eq(scheduledTasks.key, key)).limit(1);
  return decodeStoredResult(row?.lastResultJson).cursor;
}

async function finishTask(
  key: string,
  leaseOwner: string,
  outcome:
    | { status: 'ok'; startedAt: number; summary: string | null; cursor: string | null }
    | { status: 'error'; startedAt: number; error: unknown; cursor: string | null },
  finishedAt = Date.now(),
): Promise<void> {
  const now = Date.now();
  // Hobby cron runs once daily at midnight UTC. Anchor that cadence to the
  // run's UTC day so execution latency and late reconciliation cannot skip a
  // day. Long-lived installations keep their completion-based interval.
  const scheduleFrom = process.env.VERCEL
    ? Math.floor(outcome.startedAt / DAY_MS) * DAY_MS
    : finishedAt;
  await db
    .update(scheduledTasks)
    .set({
      lastStatus: outcome.status,
      lastRunAt: finishedAt,
      lastDurationMs: Math.max(0, finishedAt - outcome.startedAt),
      lastError: outcome.status === 'error' ? String(outcome.error) : null,
      // A failed run keeps the cursor it started from so progress is not lost.
      lastResultJson: encodeStoredResult(outcome.status === 'ok' ? outcome.summary : null, outcome.cursor),
      // Schedule the next run off the row's (possibly user-edited) interval.
      nextRunAt: sql`${scheduleFrom} + ${scheduledTasks.intervalMs}`,
      leaseOwner: null,
      runningSince: null,
      updatedAt: now,
    })
    .where(and(
      eq(scheduledTasks.key, key),
      eq(scheduledTasks.leaseOwner, leaseOwner),
    ));
}

function taskTimeoutError(key: string, maxRunMs: number): Error {
  return new Error(`Scheduled task "${key}" exceeded its ${maxRunMs}ms runtime limit`);
}

/** Read durable worker state at existing task entry points, never from a timer in a web request. */
async function reconcileMaintenanceTasks(): Promise<void> {
  const rows = await db.select().from(scheduledTasks).where(eq(scheduledTasks.lastStatus, 'running')) as Array<typeof scheduledTasks.$inferSelect>;
  await Promise.all(rows.map(async (row) => {
    const { operationId } = decodeStoredResult(row.lastResultJson);
    if (!operationId || !row.leaseOwner) return;
    try {
      const operation = await getComputeWorkerClient().getOperation<MaintenanceResult>(operationId, { signal: AbortSignal.timeout(10_000) });
      if (operation?.subject.kind === 'maintenance' && operation.subject.runId !== row.leaseOwner) return;
      if (operation && (operation.status === 'queued' || operation.status === 'running')) {
        // A long-running job is alive even when no admin has the panel open.
        await db.update(scheduledTasks).set({ runningSince: Date.now() }).where(and(
          eq(scheduledTasks.key, row.key), eq(scheduledTasks.leaseOwner, row.leaseOwner),
        ));
        return;
      }
      const result = operation?.result;
      await finishTask(row.key, row.leaseOwner, operation?.status === 'succeeded' && result && result.failed === 0
        ? { status: 'ok', startedAt: operation.queuedAt, summary: result.summary, cursor: null }
        : { status: 'error', startedAt: operation?.queuedAt ?? Number(row.runningSince ?? row.updatedAt), error: result?.summary ?? operation?.error?.message ?? 'Maintenance operation expired; run the task again', cursor: null },
      operation?.updatedAt ?? Date.now());
    } catch (error) {
      // An unavailable worker is not evidence that its durable job stopped.
      // Renew the control-plane lease rather than starting a duplicate job.
      await db.update(scheduledTasks).set({ runningSince: Date.now() }).where(and(
        eq(scheduledTasks.key, row.key), eq(scheduledTasks.leaseOwner, row.leaseOwner),
      ));
      serverLogger.warn({ event: 'tasks.reconcile.failed', key: row.key, error: String(error) }, 'Unable to read maintenance operation');
    }
  }));
}

async function executeTask(key: string, def: TaskDef, leaseOwner: string): Promise<void> {
  const startedAt = Date.now();
  const maxRunMs = def.maxRunMs ?? DEFAULT_TASK_MAX_RUN_MS;
  const controller = new AbortController();
  const cursor = await readTaskCursor(key);
  const context: TaskContext = {
    runId: leaseOwner,
    signal: controller.signal,
    deadlineAt: startedAt + maxRunMs,
    cursor,
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      def.run(context),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(taskTimeoutError(key, maxRunMs));
        }, maxRunMs);
      }),
    ]);
    const summary = result && typeof result.summary === 'string' ? result.summary : null;
    if (result?.operationId) {
      await db.update(scheduledTasks).set({
        lastResultJson: encodeStoredResult(summary, null, result.operationId),
        lastError: null, updatedAt: Date.now(),
      }).where(and(eq(scheduledTasks.key, key), eq(scheduledTasks.leaseOwner, leaseOwner)));
      return;
    }
    await finishTask(key, leaseOwner, {
      status: 'ok',
      startedAt,
      summary,
      cursor: result && typeof result.cursor === 'string' ? result.cursor : null,
    });
  } catch (error) {
    logDegraded(serverLogger, {
      event: 'tasks.run.failed',
      msg: `Scheduled task "${key}" failed`,
      step: key,
      error,
    });
    await finishTask(key, leaseOwner, { status: 'error', startedAt, error, cursor });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Run every task that is due (interval elapsed or a manual run was requested),
 * claiming each first so concurrent ticks don't double-run. Safe to call from
 * any trigger: the self-host interval, a Vercel cron route, or a manual run.
 *
 * Every due task is claimed before any runs. `sequential` runs them one after
 * another: on SQLite a task holding the transaction connection would otherwise
 * stall the event loop for the busy timeout when another task writes.
 */
export async function runDueTasks(options?: { registry?: TaskRegistry; sequential?: boolean }): Promise<void> {
  const registry = options?.registry ?? TASK_REGISTRY;
  await ensureTaskRows(registry);
  await reconcileMaintenanceTasks();

  const now = Date.now();
  const rows = await db.select().from(scheduledTasks);

  const claimed: Array<{ key: string; def: TaskDef; leaseOwner: string }> = [];
  for (const row of rows) {
    const def = registry[row.key];
    if (!def) continue; // orphaned row for a task no longer in the registry

    const due =
      row.runRequested ||
      (row.enabled && row.nextRunAt != null && now >= Number(row.nextRunAt));
    if (!due) continue;

    const leaseOwner = await claimTask(row.key, now);
    if (leaseOwner) claimed.push({ key: row.key, def, leaseOwner });
  }
  if (options?.sequential) {
    for (const task of claimed) await executeTask(task.key, task.def, task.leaseOwner);
    return;
  }
  await Promise.all(claimed.map((task) => executeTask(task.key, task.def, task.leaseOwner)));
}

/**
 * Run a single task immediately, regardless of schedule. Returns false if the
 * key is unknown or the task is already running.
 */
export async function runTaskNow(key: string, registry: TaskRegistry = TASK_REGISTRY): Promise<boolean> {
  const def = registry[key];
  if (!def) return false;
  await ensureTaskRows(registry);
  await reconcileMaintenanceTasks();
  const leaseOwner = await claimTask(key, Date.now());
  if (!leaseOwner) return false;
  await executeTask(key, def, leaseOwner);
  return true;
}

/** Update a task's user-editable fields (enable/disable, run interval). */
export async function updateTask(
  key: string,
  patch: { enabled?: boolean; intervalMs?: number },
): Promise<void> {
  const def = Object.hasOwn(TASK_REGISTRY, key) ? TASK_REGISTRY[key] : undefined;
  if (!def) return;

  const now = Date.now();
  const set: Record<string, unknown> = { updatedAt: now };
  if (typeof patch.enabled === 'boolean') set.enabled = patch.enabled;
  if (typeof patch.intervalMs === 'number' && Number.isFinite(patch.intervalMs) && patch.intervalMs > 0) {
    set.intervalMs = Math.max(1, Math.floor(patch.intervalMs));
  }
  await db
    .insert(scheduledTasks)
    .values({
      key,
      enabled: typeof set.enabled === 'boolean' ? set.enabled : def.defaultEnabled ?? true,
      intervalMs: typeof set.intervalMs === 'number' ? set.intervalMs : def.defaultIntervalMs,
      lastStatus: 'idle',
      nextRunAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: scheduledTasks.key,
      set,
    });
}

export type TaskView = {
  operationId: string | null;
  key: string;
  name: string;
  description?: string;
  enabled: boolean;
  intervalMs: number;
  lastStatus: TaskRunStatus;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResult: string | null;
  nextRunAt: number | null;
  running: boolean;
};

/** Combined registry + stored-state view for the admin tasks UI. */
export async function listTasks(registry: TaskRegistry = TASK_REGISTRY): Promise<TaskView[]> {
  await ensureTaskRows(registry);
  await reconcileMaintenanceTasks();
  const rows = await db.select().from(scheduledTasks);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byKey = new Map<string, any>(rows.map((row: any) => [row.key, row]));

  return Object.entries(registry).map(([key, def]) => {
    const row = byKey.get(key);
    return {
      operationId: decodeStoredResult(row?.lastResultJson).operationId,
      key,
      name: def.name,
      description: def.description,
      enabled: !!row?.enabled,
      intervalMs: Number(row?.intervalMs ?? def.defaultIntervalMs),
      lastStatus: (row?.lastStatus ?? 'idle') as TaskRunStatus,
      lastRunAt: row?.lastRunAt != null ? Number(row.lastRunAt) : null,
      lastDurationMs: row?.lastDurationMs != null ? Number(row.lastDurationMs) : null,
      lastError: row?.lastError ?? null,
      lastResult: decodeStoredResult(row?.lastResultJson).summary,
      nextRunAt: row?.nextRunAt != null ? Number(row.nextRunAt) : null,
      running: row?.lastStatus === 'running',
    };
  });
}

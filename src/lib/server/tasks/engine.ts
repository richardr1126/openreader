import { randomUUID } from 'node:crypto';
import { and, eq, lt, ne, or, sql } from 'drizzle-orm';
import { db } from '@/db';
import { scheduledTasks } from '@/db/schema';
import { serverLogger } from '@/lib/server/logger';
import { logDegraded } from '@/lib/server/errors/logging';
import { TASK_REGISTRY } from './registry';
import type { TaskContext, TaskDef, TaskRegistry, TaskRunStatus } from './types';

// A task still marked 'running' after this long is assumed abandoned (process
// crashed mid-run) and may be reclaimed by the next tick.
const STALE_RUNNING_MS = 60 * 60 * 1000;
const DEFAULT_TASK_MAX_RUN_MS = 4 * 60 * 1000;

/**
 * Seed a `scheduled_tasks` row for every registered task. Idempotent: existing
 * rows (including user-edited interval/enabled) are left untouched.
 */
async function ensureTaskRows(registry: TaskRegistry = TASK_REGISTRY): Promise<void> {
  const now = Date.now();
  for (const [key, def] of Object.entries(registry)) {
    await db
      .insert(scheduledTasks)
      .values({
        key,
        enabled: true,
        intervalMs: def.defaultIntervalMs,
        lastStatus: 'idle',
        nextRunAt: now,
      })
      .onConflictDoNothing();
  }
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

async function finishTask(
  key: string,
  leaseOwner: string,
  outcome:
    | { status: 'ok'; startedAt: number; summary: string | null }
    | { status: 'error'; startedAt: number; error: unknown },
): Promise<void> {
  const now = Date.now();
  await db
    .update(scheduledTasks)
    .set({
      lastStatus: outcome.status,
      lastRunAt: now,
      lastDurationMs: now - outcome.startedAt,
      lastError: outcome.status === 'error' ? String(outcome.error) : null,
      lastResultJson: outcome.status === 'ok' && outcome.summary ? outcome.summary : null,
      // Schedule the next run off the row's (possibly user-edited) interval.
      nextRunAt: sql`${now} + ${scheduledTasks.intervalMs}`,
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

async function executeTask(key: string, def: TaskDef, leaseOwner: string): Promise<void> {
  const startedAt = Date.now();
  const maxRunMs = def.maxRunMs ?? DEFAULT_TASK_MAX_RUN_MS;
  const controller = new AbortController();
  const context: TaskContext = {
    signal: controller.signal,
    deadlineAt: startedAt + maxRunMs,
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
    await finishTask(key, leaseOwner, { status: 'ok', startedAt, summary });
  } catch (error) {
    logDegraded(serverLogger, {
      event: 'tasks.run.failed',
      msg: `Scheduled task "${key}" failed`,
      step: key,
      error,
    });
    await finishTask(key, leaseOwner, { status: 'error', startedAt, error });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Run every task that is due (interval elapsed or a manual run was requested),
 * claiming each first so concurrent ticks don't double-run. Safe to call from
 * any trigger: the self-host interval, a Vercel cron route, or a manual run.
 */
export async function runDueTasks(options?: { registry?: TaskRegistry }): Promise<void> {
  const registry = options?.registry ?? TASK_REGISTRY;
  await ensureTaskRows(registry);

  const now = Date.now();
  const rows = await db.select().from(scheduledTasks);

  const executions: Promise<void>[] = [];
  for (const row of rows) {
    const def = registry[row.key];
    if (!def) continue; // orphaned row for a task no longer in the registry

    const due =
      row.runRequested ||
      (row.enabled && row.nextRunAt != null && now >= Number(row.nextRunAt));
    if (!due) continue;

    const leaseOwner = await claimTask(row.key, now);
    if (!leaseOwner) continue;
    executions.push(executeTask(row.key, def, leaseOwner));
  }
  await Promise.all(executions);
}

/**
 * Run a single task immediately, regardless of schedule. Returns false if the
 * key is unknown or the task is already running.
 */
export async function runTaskNow(key: string, registry: TaskRegistry = TASK_REGISTRY): Promise<boolean> {
  const def = registry[key];
  if (!def) return false;
  await ensureTaskRows(registry);
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
      enabled: typeof set.enabled === 'boolean' ? set.enabled : true,
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
  const rows = await db.select().from(scheduledTasks);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byKey = new Map<string, any>(rows.map((row: any) => [row.key, row]));

  return Object.entries(registry).map(([key, def]) => {
    const row = byKey.get(key);
    return {
      key,
      name: def.name,
      description: def.description,
      enabled: !!row?.enabled,
      intervalMs: Number(row?.intervalMs ?? def.defaultIntervalMs),
      lastStatus: (row?.lastStatus ?? 'idle') as TaskRunStatus,
      lastRunAt: row?.lastRunAt != null ? Number(row.lastRunAt) : null,
      lastDurationMs: row?.lastDurationMs != null ? Number(row.lastDurationMs) : null,
      lastError: row?.lastError ?? null,
      lastResult: row?.lastResultJson ?? null,
      nextRunAt: row?.nextRunAt != null ? Number(row.nextRunAt) : null,
      running: row?.lastStatus === 'running',
    };
  });
}

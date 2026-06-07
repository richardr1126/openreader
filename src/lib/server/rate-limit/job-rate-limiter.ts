import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/db';
import { userJobEvents } from '@/db/schema';
import { nowTimestampMs } from '@/lib/shared/timestamps';
import type { RuntimeConfig } from '@/lib/server/admin/settings';

/**
 * Per-user rate / concurrency limiting for expensive compute operations.
 *
 * Backed by the `user_job_events` ledger: one row is recorded per created
 * worker op, and limits are enforced by COUNTing rows for a (userId, action)
 * within trailing time windows. Two windows are configured per action:
 *   - a short "burst" window (stops tight retry/replace loops), and
 *   - a wider "sustained" window. Because the worker bounds each op by a hard
 *     cap, "ops created in the sustained window" is an upper bound on the
 *     number that can still be running — i.e. an effective concurrency cap.
 *
 * Limits are configured by site admins via runtime config (not env), mirroring
 * the TTS rate limiter. The design is generic: add a new `JobRateAction` plus a
 * config mapping to throttle a different job type. Limits are a backstop — a
 * small overshoot under highly concurrent requests is acceptable (the check is
 * read-then-record, not a single atomic transaction).
 */
export type JobRateAction = 'pdf_layout';

export interface JobRateWindow {
  windowMs: number;
  max: number;
}

export interface JobRateConfig {
  enabled: boolean;
  windows: JobRateWindow[];
}

export interface JobRateDecision {
  allowed: boolean;
  /** Milliseconds until the binding window frees a slot (0 when allowed). */
  retryAfterMs: number;
  counts: Array<{ windowMs: number; max: number; count: number }>;
}

/** Builds the PDF-layout parse limiter config from resolved runtime config. */
export function getPdfLayoutRateConfig(runtime: Pick<
  RuntimeConfig,
  | 'disableComputeRateLimit'
  | 'computeParseBurstMax'
  | 'computeParseBurstWindowSec'
  | 'computeParseSustainedMax'
  | 'computeParseSustainedWindowSec'
>): JobRateConfig {
  return {
    enabled: !runtime.disableComputeRateLimit,
    windows: [
      { windowMs: runtime.computeParseBurstWindowSec * 1000, max: runtime.computeParseBurstMax },
      { windowMs: runtime.computeParseSustainedWindowSec * 1000, max: runtime.computeParseSustainedMax },
    ],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const safeDb = () => db as any;

function isActive(config: Pick<JobRateConfig, 'enabled'>, userId: string | null | undefined): userId is string {
  return config.enabled && Boolean(userId);
}

async function countSince(userId: string, action: JobRateAction, since: number): Promise<number> {
  const rows = await safeDb()
    .select({ c: sql<number>`count(*)` })
    .from(userJobEvents)
    .where(and(
      eq(userJobEvents.userId, userId),
      eq(userJobEvents.action, action),
      gte(userJobEvents.createdAt, since),
    ));
  return Number(rows[0]?.c ?? 0);
}

async function oldestSince(userId: string, action: JobRateAction, since: number): Promise<number | null> {
  const rows = await safeDb()
    .select({ oldest: sql<number>`min(${userJobEvents.createdAt})` })
    .from(userJobEvents)
    .where(and(
      eq(userJobEvents.userId, userId),
      eq(userJobEvents.action, action),
      gte(userJobEvents.createdAt, since),
    ));
  const value = rows[0]?.oldest;
  return value == null ? null : Number(value);
}

/**
 * Returns whether a new op may be created for this user/action. Read-only — call
 * `recordJobEvent` after the op is actually created.
 */
export async function checkJobRate(
  userId: string | null | undefined,
  action: JobRateAction,
  config: JobRateConfig,
): Promise<JobRateDecision> {
  if (!isActive(config, userId)) {
    return { allowed: true, retryAfterMs: 0, counts: [] };
  }

  const now = nowTimestampMs();
  const counts: JobRateDecision['counts'] = [];
  let retryAfterMs = 0;
  let allowed = true;

  for (const window of config.windows) {
    if (!Number.isFinite(window.windowMs) || window.windowMs <= 0 || window.max <= 0) continue;
    const since = now - window.windowMs;
    const count = await countSince(userId, action, since);
    counts.push({ windowMs: window.windowMs, max: window.max, count });
    if (count >= window.max) {
      allowed = false;
      const oldest = await oldestSince(userId, action, since);
      // When the oldest in-window event ages out, a slot frees up.
      const freesAt = (oldest ?? now) + window.windowMs;
      retryAfterMs = Math.max(retryAfterMs, Math.max(0, freesAt - now));
    }
  }

  return { allowed, retryAfterMs, counts };
}

/** Records a created op so it counts toward future window checks. */
export async function recordJobEvent(
  userId: string | null | undefined,
  action: JobRateAction,
  opId: string,
  config: JobRateConfig,
): Promise<void> {
  if (!isActive(config, userId) || !opId) return;

  const now = nowTimestampMs();
  try {
    await safeDb()
      .insert(userJobEvents)
      .values({ userId, action, opId, createdAt: now })
      .onConflictDoNothing({ target: [userJobEvents.userId, userJobEvents.action, userJobEvents.opId] });
  } catch {
    // Recording is best-effort; never block op creation on ledger writes.
  }
  // Old rows are removed by the prune-job-events scheduled task.
}

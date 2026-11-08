import { and, eq, sql } from 'drizzle-orm';
import { db } from '@openreader/database';
import { runInDbTransaction } from '@openreader/database/run-in-transaction';
import { computeLimitBuckets, computeLimitEvents } from '@openreader/database/schema';
import type {
  ComputeAction,
  ComputeLimitPolicyDocument,
  ComputeUsageMetric,
} from '@openreader/runtime-config/compute-limits';
import {
  applicableUsageLimits,
  computePolicyVersion,
  resolveComputeScope,
  utcDayWindow,
  type ComputeLimitSubject,
} from './policy';

export interface ComputeUsageBucketResult {
  scope: string;
  used: number;
  limit: number;
  remaining: number;
  resetAt: number;
}

export interface ComputeUsageDecision {
  allowed: boolean;
  charged: boolean;
  idempotent: boolean;
  buckets: ComputeUsageBucketResult[];
  retryAfterMs: number;
}

type ResolvedLimit = {
  scope: string;
  scopeKey: string;
  limit: number;
  boundary: 'strict' | 'soft_unit';
  windowStart: number;
  windowEnd: number;
};

class ComputeUsageDenied extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Compute usage limit reached');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const safeDb = () => db as any;

function rowsAffected(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const result = value as Record<string, unknown>;
  if (typeof result.rowCount === 'number') return result.rowCount;
  if (typeof result.changes === 'number') return result.changes;
  return 0;
}

function resolveLimits(input: {
  policy: ComputeLimitPolicyDocument;
  action: ComputeAction;
  metric: Exclude<ComputeUsageMetric, 'starts'>;
  subject: ComputeLimitSubject;
  nowMs: number;
}): ResolvedLimit[] {
  const window = utcDayWindow(input.nowMs);
  return applicableUsageLimits(input.policy, input.action, input.subject)
    .filter((limit) => limit.metric === input.metric)
    .map((limit) => {
      const scope = resolveComputeScope(limit.scope, input.subject);
      return {
        scope: scope.scope,
        scopeKey: scope.key,
        limit: limit.limit,
        boundary: limit.boundary,
        windowStart: window.startMs,
        windowEnd: window.endMs,
      };
    });
}

async function readBuckets(
  action: ComputeAction,
  metric: Exclude<ComputeUsageMetric, 'starts'>,
  limits: ResolvedLimit[],
): Promise<ComputeUsageBucketResult[]> {
  const results: ComputeUsageBucketResult[] = [];
  for (const limit of limits) {
    const rows = await safeDb().select({ used: computeLimitBuckets.used })
      .from(computeLimitBuckets)
      .where(and(
        eq(computeLimitBuckets.scopeType, limit.scope),
        eq(computeLimitBuckets.scopeKey, limit.scopeKey),
        eq(computeLimitBuckets.action, action),
        eq(computeLimitBuckets.metric, metric),
        eq(computeLimitBuckets.windowStart, limit.windowStart),
      ));
    const used = Number(rows[0]?.used ?? 0);
    results.push({
      scope: limit.scope,
      used,
      limit: limit.limit,
      remaining: Math.max(0, limit.limit - used),
      resetAt: limit.windowEnd,
    });
  }
  return results;
}

export async function getComputeUsage(input: {
  policy: ComputeLimitPolicyDocument;
  action: ComputeAction;
  metric: Exclude<ComputeUsageMetric, 'starts'>;
  subject: ComputeLimitSubject;
  nowMs?: number;
}): Promise<ComputeUsageDecision> {
  const nowMs = input.nowMs ?? Date.now();
  const actionPolicy = input.policy.actions[input.action];
  if (!actionPolicy.enabled) {
    return {
      allowed: true,
      charged: false,
      idempotent: false,
      buckets: [],
      retryAfterMs: 0,
    };
  }
  const limits = resolveLimits({ ...input, nowMs });
  const buckets = await readBuckets(input.action, input.metric, limits);
  const denied = buckets.some((bucket) => bucket.used >= bucket.limit);
  return {
    allowed: !denied,
    charged: false,
    idempotent: false,
    buckets,
    retryAfterMs: denied ? Math.max(0, Math.min(...buckets
      .filter((bucket) => bucket.used >= bucket.limit)
      .map((bucket) => bucket.resetAt - nowMs))) : 0,
  };
}

/**
 * Charges one complete work unit. `soft_unit` means the unit is admitted when
 * every applicable bucket starts below its limit, then the full unit is added.
 * A later unit is denied. The event key makes retries free.
 */
export async function consumeComputeUsage(input: {
  policy: ComputeLimitPolicyDocument;
  action: ComputeAction;
  metric: Exclude<ComputeUsageMetric, 'starts'>;
  units: number;
  eventKey: string;
  subject: ComputeLimitSubject;
  admissionId?: string | null;
  nowMs?: number;
}): Promise<ComputeUsageDecision> {
  if (!Number.isSafeInteger(input.units) || input.units <= 0) {
    throw new Error('Compute usage units must be a positive integer');
  }
  if (!input.eventKey.trim() || input.eventKey.length > 512) {
    throw new Error('Compute usage event key is invalid');
  }
  const nowMs = input.nowMs ?? Date.now();
  const actionPolicy = input.policy.actions[input.action];
  if (!actionPolicy.enabled) {
    return {
      allowed: true,
      charged: false,
      idempotent: false,
      buckets: [],
      retryAfterMs: 0,
    };
  }
  const limits = resolveLimits({ ...input, nowMs });
  if (limits.length === 0) {
    return {
      allowed: true,
      charged: false,
      idempotent: false,
      buckets: [],
      retryAfterMs: 0,
    };
  }

  try {
    const transactionResult = await runInDbTransaction(async (conn) => {
      const inserted = await conn.insert(computeLimitEvents).values({
        eventKey: input.eventKey,
        admissionId: input.admissionId ?? null,
        userId: input.subject.userId,
        action: input.action,
        metric: input.metric,
        units: input.units,
        policyVersion: computePolicyVersion(input.policy),
        createdAt: nowMs,
      }).onConflictDoNothing({ target: computeLimitEvents.eventKey });
      if (rowsAffected(inserted) === 0) return { idempotent: true };

      for (const limit of limits) {
        await conn.insert(computeLimitBuckets).values({
          scopeType: limit.scope,
          scopeKey: limit.scopeKey,
          action: input.action,
          metric: input.metric,
          windowStart: limit.windowStart,
          windowEnd: limit.windowEnd,
          used: 0,
          updatedAt: nowMs,
        }).onConflictDoNothing({
          target: [
            computeLimitBuckets.scopeType,
            computeLimitBuckets.scopeKey,
            computeLimitBuckets.action,
            computeLimitBuckets.metric,
            computeLimitBuckets.windowStart,
          ],
        });

        const baseWhere = and(
          eq(computeLimitBuckets.scopeType, limit.scope),
          eq(computeLimitBuckets.scopeKey, limit.scopeKey),
          eq(computeLimitBuckets.action, input.action),
          eq(computeLimitBuckets.metric, input.metric),
          eq(computeLimitBuckets.windowStart, limit.windowStart),
        );
        const updated = await conn.update(computeLimitBuckets).set({
          used: sql`${computeLimitBuckets.used} + ${input.units}`,
          updatedAt: nowMs,
        }).where(and(baseWhere, limit.boundary === 'soft_unit'
          ? sql`${computeLimitBuckets.used} < ${limit.limit}`
          : sql`${computeLimitBuckets.used} + ${input.units} <= ${limit.limit}`));
        if (rowsAffected(updated) === 0) {
          throw new ComputeUsageDenied(Math.max(0, limit.windowEnd - nowMs));
        }
      }
      return { idempotent: false };
    });

    const current = await getComputeUsage({ ...input, nowMs });
    return {
      ...current,
      allowed: true,
      charged: !transactionResult.idempotent,
      idempotent: transactionResult.idempotent,
    };
  } catch (error) {
    if (!(error instanceof ComputeUsageDenied)) throw error;
    const current = await getComputeUsage({ ...input, nowMs });
    return { ...current, allowed: false, charged: false, retryAfterMs: error.retryAfterMs };
  }
}

import { db } from '@/db';
import { runInDbTransaction } from '@/db/run-in-transaction';
import { userTtsChars } from '@/db/schema';
import { eq, and, lt, sql } from 'drizzle-orm';
import { nextUtcMidnightTimestampMs, nowTimestampMs } from '@/lib/shared/timestamps';

export interface RateLimitThresholds {
  anonymous: number;
  authenticated: number;
  ipAnonymous: number;
  ipAuthenticated: number;
}

export interface RateLimitRuntimeOptions {
  enabled: boolean;
  limits: RateLimitThresholds;
}

export const DEFAULT_RATE_LIMITS: RateLimitThresholds = {
  anonymous: 50_000,
  authenticated: 500_000,
  ipAnonymous: 100_000,
  ipAuthenticated: 1_000_000,
};

export function resolveRateLimitThresholds(input?: Partial<RateLimitThresholds>): RateLimitThresholds {
  const source = input ?? {};
  const normalize = (value: unknown, fallback: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
    return Math.floor(value);
  };

  return {
    anonymous: normalize(source.anonymous, DEFAULT_RATE_LIMITS.anonymous),
    authenticated: normalize(source.authenticated, DEFAULT_RATE_LIMITS.authenticated),
    ipAnonymous: normalize(source.ipAnonymous, DEFAULT_RATE_LIMITS.ipAnonymous),
    ipAuthenticated: normalize(source.ipAuthenticated, DEFAULT_RATE_LIMITS.ipAuthenticated),
  };
}

// Helper to ensure DB is strictly typed when we know it exists
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const safeDb = () => db as any;

type UserTtsCharsInsert = typeof userTtsChars.$inferInsert;
type UserTtsCharsDateValue = UserTtsCharsInsert['date'];
type UserTtsCharsUpdatedAtValue = UserTtsCharsInsert['updatedAt'];


export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  resetTimeMs: number;
  remainingChars: number;
}

export interface UserInfo {
  id: string;
  isAnonymous?: boolean;
  isPro?: boolean;
}

export interface RateLimitBackstops {
  /** Stable device identifier cookie value (server-issued). */
  deviceId?: string | null;
  /** Best-effort client IP (from proxy headers). */
  ip?: string | null;
}

type Bucket = {
  key: string;
  limit: number;
};

function normalizeBackstopKey(prefix: string, value: string): string {
  const trimmed = value.trim();
  const safe = trimmed.length > 128 ? trimmed.slice(0, 128) : trimmed;
  return `${prefix}:${safe}`;
}

function pickEffectiveResult(results: Array<{ currentCount: number; limit: number }>): {
  currentCount: number;
  limit: number;
  remainingChars: number;
  allowed: boolean;
} {
  if (results.length === 0) {
    return {
      allowed: true,
      currentCount: 0,
      limit: Number.MAX_SAFE_INTEGER,
      remainingChars: Number.MAX_SAFE_INTEGER,
    };
  }

  let binding = results[0];
  let bindingRemaining = Math.max(0, binding.limit - binding.currentCount);

  for (const r of results) {
    const remaining = Math.max(0, r.limit - r.currentCount);
    if (remaining < bindingRemaining) {
      binding = r;
      bindingRemaining = remaining;
    }
  }

  return {
    allowed: results.every(r => r.currentCount < r.limit),
    currentCount: binding.currentCount,
    limit: binding.limit,
    remainingChars: bindingRemaining,
  };
}

class RateLimitExceeded extends Error {
  name = 'RateLimitExceeded' as const;
}

function getRowsAffected(result: unknown): number {
  if (typeof result !== 'object' || result === null) return 0;
  const rec = result as Record<string, unknown>;
  if (typeof rec.rowCount === 'number') return rec.rowCount;
  if (typeof rec.changes === 'number') return rec.changes;
  return 0;
}

export class RateLimiter {
  constructor() { }

  private getUpdatedAtValue(): number {
    return nowTimestampMs();
  }

  /**
   * Check if a user can use TTS and increment their char count if allowed
   */
  async checkAndIncrementLimit(
    user: UserInfo,
    charCount: number,
    backstops?: RateLimitBackstops,
    options?: RateLimitRuntimeOptions,
  ): Promise<RateLimitResult> {
    const limits = resolveRateLimitThresholds(options?.limits);
    const enabled = options?.enabled ?? true;
    if (!enabled) {
      return {
        allowed: true,
        currentCount: 0,
        limit: Number.MAX_SAFE_INTEGER,
        resetTimeMs: this.getResetTimeMs(),
        remainingChars: Number.MAX_SAFE_INTEGER
      };
    }

    const today = new Date().toISOString().split('T')[0];
    const dateValue = today as unknown as UserTtsCharsDateValue;
    const userLimit = user.isAnonymous ? limits.anonymous : limits.authenticated;

    const buckets: Bucket[] = [{ key: user.id, limit: userLimit }];

    const deviceId = backstops?.deviceId?.toString() || null;
    const ip = backstops?.ip?.toString() || null;

    if (user.isAnonymous && deviceId) {
      buckets.push({ key: normalizeBackstopKey('device', deviceId), limit: limits.anonymous });
    }

    if (ip) {
      buckets.push({
        key: normalizeBackstopKey('ip', ip),
        limit: user.isAnonymous ? limits.ipAnonymous : limits.ipAuthenticated,
      });
    }

    try {
      const updatedAt = this.getUpdatedAtValue() as unknown as UserTtsCharsUpdatedAtValue;
      return await runInDbTransaction(async (conn) => {
        // Ensure records exist for each bucket
        for (const bucket of buckets) {
          await conn.insert(userTtsChars)
            .values({
              userId: bucket.key,
              date: dateValue,
              charCount: 0,
            })
            .onConflictDoUpdate({
              target: [userTtsChars.userId, userTtsChars.date],
              set: { updatedAt },
            });
        }

        // Attempt to increment each bucket. The `lt(..., limit)` guard blocks requests
        // that start after the bucket is already exhausted, while still allowing a
        // request to push the count over the limit.
        for (const bucket of buckets) {
          const updateResult = await conn.update(userTtsChars)
            .set({
              charCount: sql`${userTtsChars.charCount} + ${charCount}`,
              updatedAt,
            })
            .where(and(
              eq(userTtsChars.userId, bucket.key),
              eq(userTtsChars.date, dateValue),
              lt(userTtsChars.charCount, bucket.limit)
            ));

          if (getRowsAffected(updateResult) <= 0) {
            throw new RateLimitExceeded();
          }
        }

        // Fetch current counts
        const bucketResults: Array<{ currentCount: number; limit: number }> = [];
        for (const bucket of buckets) {
          const result = await conn.select({ currentCount: userTtsChars.charCount })
            .from(userTtsChars)
            .where(and(eq(userTtsChars.userId, bucket.key), eq(userTtsChars.date, dateValue)));

          const currentCount = result[0]?.currentCount ? Number(result[0].currentCount) : 0;
          bucketResults.push({ currentCount, limit: bucket.limit });
        }

        const effective = pickEffectiveResult(bucketResults);

        return {
          allowed: true,
          currentCount: effective.currentCount,
          limit: effective.limit,
          resetTimeMs: this.getResetTimeMs(),
          remainingChars: effective.remainingChars,
        };
      });
    } catch (error) {
      if (error instanceof RateLimitExceeded) {
        const current = await this.getCurrentUsage(user, backstops, options);
        return { ...current, allowed: false };
      }
      throw error;
    }
  }

  /**
   * Get current usage for a user without incrementing
   */
  async getCurrentUsage(
    user: UserInfo,
    backstops?: RateLimitBackstops,
    options?: RateLimitRuntimeOptions,
  ): Promise<RateLimitResult> {
    const limits = resolveRateLimitThresholds(options?.limits);
    const enabled = options?.enabled ?? true;
    if (!enabled) {
      return {
        allowed: true,
        currentCount: 0,
        limit: Number.MAX_SAFE_INTEGER,
        resetTimeMs: this.getResetTimeMs(),
        remainingChars: Number.MAX_SAFE_INTEGER
      };
    }

    const today = new Date().toISOString().split('T')[0];
    const userLimit = user.isAnonymous ? limits.anonymous : limits.authenticated;

    const buckets: Bucket[] = [{ key: user.id, limit: userLimit }];

    const deviceId = backstops?.deviceId?.toString() || null;
    const ip = backstops?.ip?.toString() || null;

    if (user.isAnonymous && deviceId) {
      buckets.push({ key: normalizeBackstopKey('device', deviceId), limit: limits.anonymous });
    }

    if (ip) {
      buckets.push({
        key: normalizeBackstopKey('ip', ip),
        limit: user.isAnonymous ? limits.ipAnonymous : limits.ipAuthenticated,
      });
    }

    const bucketResults: Array<{ currentCount: number; limit: number }> = [];

    for (const bucket of buckets) {
      const result = await safeDb().select({ charCount: userTtsChars.charCount })

        .from(userTtsChars)
        .where(and(eq(userTtsChars.userId, bucket.key), eq(userTtsChars.date, today)));

      const currentCount = result[0]?.charCount ? Number(result[0].charCount) : 0;
      bucketResults.push({ currentCount, limit: bucket.limit });
    }

    const effective = pickEffectiveResult(bucketResults);

    return {
      allowed: effective.allowed,
      currentCount: effective.currentCount,
      limit: effective.limit,
      resetTimeMs: this.getResetTimeMs(),
      remainingChars: effective.remainingChars,
    };
  }

  /**
   * Transfer char counts when anonymous user creates an account
   */
  async transferAnonymousUsage(anonymousUserId: string, authenticatedUserId: string): Promise<void> {
    const updatedAt = this.getUpdatedAtValue() as unknown as UserTtsCharsUpdatedAtValue;

    await runInDbTransaction(async (conn) => {
      const anonymousRows = await conn.select({
        date: userTtsChars.date,
        charCount: userTtsChars.charCount,
      })
        .from(userTtsChars)
        .where(eq(userTtsChars.userId, anonymousUserId));

      for (const anonymousRow of anonymousRows) {
        const dateValue = anonymousRow.date as unknown as UserTtsCharsDateValue;
        const anonymousCount = Number(anonymousRow.charCount ?? 0);

        await conn.insert(userTtsChars)
          .values({ userId: authenticatedUserId, date: dateValue, charCount: anonymousCount })
          .onConflictDoUpdate({
            target: [userTtsChars.userId, userTtsChars.date],
            set: {
              charCount: sql`${userTtsChars.charCount} + ${anonymousCount}`,
              updatedAt,
            },
          });
      }

      await conn.delete(userTtsChars)
        .where(eq(userTtsChars.userId, anonymousUserId));
    });
  }

  /**
   * Clean up old records (optional maintenance)
   */
  async cleanupOldRecords(daysToKeep: number = 30): Promise<void> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffDateStr = cutoffDate.toISOString().split('T')[0];
    const cutoffDateValue = cutoffDateStr as unknown as UserTtsCharsDateValue;

    // Assuming string comparison works for YYYY-MM-DD
    await safeDb().delete(userTtsChars).where(lt(userTtsChars.date, cutoffDateValue));
  }

  private getResetTimeMs(): number {
    return nextUtcMidnightTimestampMs();
  }
}

// Export singleton instance
export const rateLimiter = new RateLimiter();

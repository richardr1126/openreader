import { and, eq, gt, sql } from 'drizzle-orm';
import { APIError } from 'better-auth/api';
import { runInDbTransaction } from '@openreader/database/run-in-transaction';
import { computeLimitBuckets } from '@openreader/database/schema';
import type { RuntimeConfig } from '@/lib/server/admin/settings';
import { hashIp } from './ip-privacy';

/** The zero-time bucket serializes each IP; timestamped buckets hold rolling counts. */
export async function enforceCreationLimit(input: {
  ip: string | null;
  isAnonymous: boolean;
  config: RuntimeConfig;
  nowMs?: number;
}): Promise<void> {
  const { config, isAnonymous } = input;
  if (!(isAnonymous ? config.limitNewGuestsPerIp : config.limitNewAccountsPerIp)) return;
  const scopeKey = hashIp(input.ip, isAnonymous ? 'guest-creation' : 'account-creation');
  if (!scopeKey) return;
  const nowMs = input.nowMs ?? Date.now();
  const periodMs = (isAnonymous ? config.anonymousUserIdleDays : config.newAccountsPerIpDays) * 86_400_000;
  const limit = isAnonymous ? config.newGuestsPerIp : config.newAccountsPerIp;
  const action = isAnonymous ? 'guest_creation' : 'account_creation';
  await runInDbTransaction(async (conn) => {
    const identity = { scopeType: 'creation_ip', scopeKey, action, metric: 'starts' };
    const predicate = and(eq(computeLimitBuckets.scopeType, identity.scopeType),
      eq(computeLimitBuckets.scopeKey, scopeKey), eq(computeLimitBuckets.action, action),
      eq(computeLimitBuckets.metric, 'starts'));
    await conn.insert(computeLimitBuckets).values({ ...identity, windowStart: 0, windowEnd: nowMs + periodMs, used: 0, updatedAt: nowMs })
      .onConflictDoNothing();
    await conn.update(computeLimitBuckets).set({ updatedAt: nowMs, windowEnd: nowMs + periodMs })
      .where(and(predicate, eq(computeLimitBuckets.windowStart, 0)));
    const rows = await conn.select({ used: sql<number>`coalesce(sum(${computeLimitBuckets.used}), 0)` })
      .from(computeLimitBuckets).where(and(predicate, gt(computeLimitBuckets.windowStart, nowMs - periodMs), gt(computeLimitBuckets.windowStart, 0)));
    if (Number(rows[0]?.used ?? 0) >= limit) {
      throw new APIError('TOO_MANY_REQUESTS', {
        code: 'ACCOUNT_CREATION_LIMITED',
        message: isAnonymous ? 'Too many new guests from this network. Please sign in or create an account.'
          : 'Too many new accounts from this network. Please try again later.',
      });
    }
    await conn.insert(computeLimitBuckets).values({ ...identity, windowStart: nowMs, windowEnd: nowMs + periodMs, used: 1, updatedAt: nowMs })
      .onConflictDoUpdate({ target: [computeLimitBuckets.scopeType, computeLimitBuckets.scopeKey, computeLimitBuckets.action, computeLimitBuckets.metric, computeLimitBuckets.windowStart],
        set: { used: sql`${computeLimitBuckets.used} + 1`, updatedAt: nowMs } });
  });
}

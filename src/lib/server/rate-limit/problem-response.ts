import { NextResponse } from 'next/server';
import { RATE_LIMITS, type RateLimitResult } from '@/lib/server/rate-limit/rate-limiter';

function formatLimitForHint(limit: number): string {
  if (!Number.isFinite(limit) || limit <= 0) return String(limit);
  if (limit >= 1_000_000) {
    const m = limit / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (limit >= 1_000) return `${Math.round(limit / 1_000)}K`;
  return String(limit);
}

export function buildDailyQuotaExceededResponse(input: {
  rateLimitResult: RateLimitResult;
  isAnonymousUser: boolean;
  pathname: string;
}): NextResponse {
  const { rateLimitResult, isAnonymousUser, pathname } = input;
  const resetTimeMs = rateLimitResult.resetTimeMs;
  const retryAfterSeconds = Math.max(0, Math.ceil((resetTimeMs - Date.now()) / 1000));

  return new NextResponse(JSON.stringify({
    type: 'https://openreader.app/problems/daily-quota-exceeded',
    title: 'Daily quota exceeded',
    status: 429,
    detail: 'Daily character limit exceeded',
    code: 'USER_DAILY_QUOTA_EXCEEDED',
    currentCount: rateLimitResult.currentCount,
    limit: rateLimitResult.limit,
    remainingChars: rateLimitResult.remainingChars,
    resetTimeMs,
    userType: isAnonymousUser ? 'anonymous' : 'authenticated',
    upgradeHint: isAnonymousUser
      ? `Sign up to increase your limit from ${formatLimitForHint(RATE_LIMITS.ANONYMOUS)} to ${formatLimitForHint(RATE_LIMITS.AUTHENTICATED)} characters per day`
      : undefined,
    instance: pathname,
  }), {
    status: 429,
    headers: {
      'Content-Type': 'application/problem+json',
      'Retry-After': String(retryAfterSeconds),
    },
  });
}

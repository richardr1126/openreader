import { NextResponse, type NextRequest } from 'next/server';
import type { ApiPrincipal } from './principal';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { getComputeUsage } from '@/lib/server/compute-limits/usage';
import { nextUtcMidnightTimestampMs } from '@/lib/shared/timestamps';

export async function describeMe(request: NextRequest, principal: ApiPrincipal) {
  const policy = (await getResolvedRuntimeConfig()).computeLimitPolicies;
  const enabled = policy.actions.tts_synthesis.enabled;

  const decision = await getComputeUsage({ policy, action: 'tts_synthesis', metric: 'characters', subject: {
    userId: principal.userId, isAnonymous: principal.isAnonymous,
  } });
  const binding = decision.buckets.reduce<(typeof decision.buckets)[number] | null>(
    (current, bucket) => !current || bucket.remaining < current.remaining ? bucket : current, null,
  );
  const response = NextResponse.json({ id: principal.userId, isAnonymous: principal.isAnonymous, scopes: principal.scopes,
    computeLimits: { allowed: decision.allowed, currentCount: binding?.used ?? 0, limit: binding?.limit ?? null,
      remainingChars: binding?.remaining ?? null, resetTimeMs: binding?.resetAt ?? nextUtcMidnightTimestampMs(),
      userType: principal.isAnonymous ? 'anonymous' : 'authenticated', enabled } });
  return response;
}

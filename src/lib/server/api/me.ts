import { NextResponse, type NextRequest } from 'next/server';
import type { ApiPrincipal } from './principal';
import { getResolvedRuntimeConfig } from '@/lib/server/runtime-config';
import { getComputeUsage } from '@/lib/server/compute-limits/usage';
import { getOrCreateDeviceId, setDeviceIdCookie } from '@/lib/server/rate-limit/device-id';
import { getClientIp } from '@/lib/server/rate-limit/request-ip';
import { nextUtcMidnightTimestampMs } from '@/lib/shared/timestamps';

export async function describeMe(request: NextRequest, principal: ApiPrincipal) {
  const policy = (await getResolvedRuntimeConfig()).computeLimitPolicies;
  const enabled = policy.actions.tts_synthesis.enabled;
  const device = enabled && principal.isAnonymous ? getOrCreateDeviceId(request) : null;
  const decision = await getComputeUsage({ policy, action: 'tts_synthesis', metric: 'characters', subject: {
    userId: principal.userId, isAnonymous: principal.isAnonymous,
    deviceId: device?.deviceId ?? null, ip: getClientIp(request),
  } });
  const binding = decision.buckets.reduce<(typeof decision.buckets)[number] | null>(
    (current, bucket) => !current || bucket.remaining < current.remaining ? bucket : current, null,
  );
  const response = NextResponse.json({ id: principal.userId, isAnonymous: principal.isAnonymous, scopes: principal.scopes,
    computeLimits: { allowed: decision.allowed, currentCount: binding?.used ?? 0, limit: binding?.limit ?? null,
      remainingChars: binding?.remaining ?? null, resetTimeMs: binding?.resetAt ?? nextUtcMidnightTimestampMs(),
      userType: principal.isAnonymous ? 'anonymous' : 'authenticated', enabled } });
  if (device?.didCreate) setDeviceIdCookie(response, device.deviceId);
  return response;
}

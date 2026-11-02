import { createHash, createHmac } from 'node:crypto';
import type {
  ComputeAction,
  ComputeLimitAudience,
  ComputeLimitPolicyDocument,
  ComputeLimitScope,
  ComputeUsageLimitPolicy,
} from '@openreader/runtime-config/compute-limits';

export interface ComputeLimitSubject {
  userId: string;
  isAnonymous: boolean;
}

export interface ResolvedComputeScope {
  scope: ComputeLimitScope;
  key: string;
}

function audienceFor(subject: ComputeLimitSubject): Exclude<ComputeLimitAudience, 'all'> {
  return subject.isAnonymous ? 'anonymous' : 'authenticated';
}

export function applicableUsageLimits(
  policy: ComputeLimitPolicyDocument,
  action: ComputeAction,
  subject: ComputeLimitSubject,
): ComputeUsageLimitPolicy[] {
  const audience = audienceFor(subject);
  return policy.actions[action].usage.filter((limit) => (
    (limit.audience === 'all' || limit.audience === audience)
  ));
}

function requireScopeSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error('AUTH_SECRET is required to derive compute-limit scope keys');
  return secret;
}

export function deriveComputeScopeKey(scope: ComputeLimitScope, value: string): string {
  if (scope === 'site') return 'site';
  return createHmac('sha256', requireScopeSecret())
    .update(`openreader:compute-limit:${scope}:v1\0${value.trim()}`)
    .digest('hex');
}

export function resolveComputeScope(
  scope: ComputeLimitScope,
  subject: ComputeLimitSubject,
): ResolvedComputeScope | null {
  if (scope === 'site') return { scope, key: 'site' };
  if (scope === 'user') return { scope, key: deriveComputeScopeKey(scope, subject.userId) };
  return null;
}

export function computePolicyVersion(policy: ComputeLimitPolicyDocument): number {
  const prefix = createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 12);
  return Number.parseInt(prefix, 16);
}

export function fixedWindow(nowMs: number, windowSeconds: number): {
  startMs: number;
  endMs: number;
} {
  const durationMs = windowSeconds * 1000;
  const startMs = Math.floor(nowMs / durationMs) * durationMs;
  return { startMs, endMs: startMs + durationMs };
}

export function utcDayWindow(nowMs: number): { startMs: number; endMs: number } {
  const now = new Date(nowMs);
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { startMs, endMs: startMs + 24 * 60 * 60 * 1000 };
}

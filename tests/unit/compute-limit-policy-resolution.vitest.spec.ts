import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cloneComputeLimitPolicyDocument } from '@openreader/runtime-config/compute-limits';
import {
  applicableUsageLimits,
  computePolicyVersion,
  deriveComputeScopeKey,
  fixedWindow,
  resolveComputeScope,
  utcDayWindow,
} from '@/lib/server/compute-limits/policy';

describe('compute limit policy resolution', () => {
  const originalSecret = process.env.AUTH_SECRET;

  beforeEach(() => {
    process.env.AUTH_SECRET = 'compute-limit-test-secret';
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = originalSecret;
  });

  it('selects the correct TTS limits for anonymous and authenticated subjects', () => {
    const policy = cloneComputeLimitPolicyDocument();
    const anonymous = applicableUsageLimits(policy, 'tts_synthesis', {
      userId: 'anon-1', isAnonymous: true, deviceId: 'device-1', ip: '192.0.2.1',
    });
    const authenticated = applicableUsageLimits(policy, 'tts_synthesis', {
      userId: 'user-1', isAnonymous: false, ip: '192.0.2.1',
    });

    expect(anonymous.map(({ scope, limit }) => [scope, limit])).toEqual([
      ['user', 50_000],
      ['anonymous_device', 50_000],
      ['ip', 100_000],
    ]);
    expect(authenticated.map(({ scope, limit }) => [scope, limit])).toEqual([
      ['user', 500_000],
      ['ip', 1_000_000],
    ]);
  });

  it('HMACs private scope identifiers with domain separation', () => {
    expect(deriveComputeScopeKey('ip', '192.0.2.1')).not.toContain('192.0.2.1');
    expect(deriveComputeScopeKey('ip', 'same')).not.toBe(deriveComputeScopeKey('user', 'same'));
    expect(resolveComputeScope('anonymous_device', { userId: 'u', isAnonymous: false, deviceId: 'd' }))
      .toBeNull();
  });

  it('builds stable policy versions and fixed UTC windows', () => {
    const policy = cloneComputeLimitPolicyDocument();
    expect(computePolicyVersion(policy)).toBe(computePolicyVersion(policy));
    policy.actions.pdf_layout.enabled = true;
    expect(computePolicyVersion(policy)).not.toBe(computePolicyVersion(cloneComputeLimitPolicyDocument()));

    expect(fixedWindow(61_000, 60)).toEqual({ startMs: 60_000, endMs: 120_000 });
    expect(utcDayWindow(Date.UTC(2026, 8, 8, 12))).toEqual({
      startMs: Date.UTC(2026, 8, 8),
      endMs: Date.UTC(2026, 8, 9),
    });
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cloneComputeLimitPolicyDocument,
  DEFAULT_COMPUTE_LIMIT_POLICIES,
  parseComputeLimitPolicyDocument,
} from '@openreader/runtime-config/compute-limits';
import {
  parseComputeAdmissionTerminalRequest,
  parseTtsSynthesisConsumeRequest,
  parseTtsSynthesisConsumeResponse,
} from '@openreader/runtime-config/compute-limit-broker';

describe('compute limit policy', () => {
  it('accepts the complete default policy', () => {
    expect(parseComputeLimitPolicyDocument(DEFAULT_COMPUTE_LIMIT_POLICIES))
      .toEqual(DEFAULT_COMPUTE_LIMIT_POLICIES);
    expect(DEFAULT_COMPUTE_LIMIT_POLICIES.schemaVersion).toBe(2);
    expect(JSON.stringify(DEFAULT_COMPUTE_LIMIT_POLICIES)).not.toContain('"mode"');
  });

  it('defaults self-host admission open while retaining segment usage limits', () => {
    for (const [action, policy] of Object.entries(DEFAULT_COMPUTE_LIMIT_POLICIES.actions)) {
      expect(policy.enabled, action).toBe(action === 'tts_synthesis');
    }
    expect(DEFAULT_COMPUTE_LIMIT_POLICIES.providers.defaults.enabled).toBe(true);
    expect(DEFAULT_COMPUTE_LIMIT_POLICIES.providers.defaults.maxConcurrent).toBe(3);
    expect(DEFAULT_COMPUTE_LIMIT_POLICIES.worker.maxExecutingPerWorker).toBe(3);
  });

  it('keeps the copyable architecture seed aligned with the complete default', () => {
    const plan = readFileSync(
      path.resolve(import.meta.dirname, '../../v5/COMPUTE_RATE_LIMITING_PLAN.md'),
      'utf8',
    );
    const seedSection = plan.split('Both seed forms must support the complete policy document:')[1] ?? '';
    const jsonBlock = seedSection.match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(jsonBlock).toBeDefined();
    const seed = JSON.parse(jsonBlock!) as {
      runtimeConfig: { computeLimitPolicies: unknown };
    };
    expect(parseComputeLimitPolicyDocument(seed.runtimeConfig.computeLimitPolicies))
      .toEqual(DEFAULT_COMPUTE_LIMIT_POLICIES);
  });

  it('rejects the superseded rollout-mode policy shape', () => {
    const legacy = cloneComputeLimitPolicyDocument() as unknown as {
      schemaVersion: number;
      actions: { pdf_layout: Record<string, unknown> };
    };
    legacy.schemaVersion = 1;
    legacy.actions.pdf_layout.mode = 'observe';
    delete legacy.actions.pdf_layout.enabled;

    expect(parseComputeLimitPolicyDocument(legacy)).toBeUndefined();
  });

  it('returns a detached clone', () => {
    const copy = cloneComputeLimitPolicyDocument();
    copy.actions.pdf_layout.admission.windows[0].limit = 1;

    expect(DEFAULT_COMPUTE_LIMIT_POLICIES.actions.pdf_layout.admission.windows[0].limit)
      .toBe(8);
  });

  it('rejects incomplete action coverage and unknown fields', () => {
    const incomplete = cloneComputeLimitPolicyDocument() as unknown as Record<string, unknown>;
    delete (incomplete.actions as Record<string, unknown>).document_preview;
    expect(parseComputeLimitPolicyDocument(incomplete)).toBeUndefined();

    const extended = cloneComputeLimitPolicyDocument() as unknown as Record<string, unknown>;
    extended.legacyLimit = true;
    expect(parseComputeLimitPolicyDocument(extended)).toBeUndefined();
  });

  it('requires audience-specific soft-unit TTS character limits', () => {
    const strict = cloneComputeLimitPolicyDocument();
    strict.actions.tts_synthesis.usage[0].boundary = 'strict';
    expect(parseComputeLimitPolicyDocument(strict)).toBeUndefined();

    const missingAudience = cloneComputeLimitPolicyDocument() as unknown as {
      actions: { tts_synthesis: { usage: Array<Record<string, unknown>> } };
    };
    delete missingAudience.actions.tts_synthesis.usage[0].audience;
    expect(parseComputeLimitPolicyDocument(missingAudience)).toBeUndefined();
  });

  it('rejects impossible worker resource assignments', () => {
    const impossible = cloneComputeLimitPolicyDocument();
    impossible.actions.pdf_layout.execution!.resources.cpu_heavy = 2;
    expect(parseComputeLimitPolicyDocument(impossible)).toBeUndefined();
  });

  it('rejects unwired metered units on worker operations', () => {
    const unwired = cloneComputeLimitPolicyDocument();
    unwired.actions.pdf_layout.usage = [{
      scope: 'user', audience: 'all', metric: 'input_bytes',
      window: 'utc_day', limit: 1_000_000, boundary: 'strict',
    }];
    expect(parseComputeLimitPolicyDocument(unwired)).toBeUndefined();
  });

  it('rejects policy refresh timers above the Node.js safe delay', () => {
    const maximum = cloneComputeLimitPolicyDocument();
    maximum.worker.policyRefreshSeconds = 2_147_483;
    expect(parseComputeLimitPolicyDocument(maximum)).toBeDefined();

    const overflowing = cloneComputeLimitPolicyDocument();
    overflowing.worker.policyRefreshSeconds = 2_147_484;
    expect(parseComputeLimitPolicyDocument(overflowing)).toBeUndefined();
  });
});

describe('compute limit broker contracts', () => {
  it('strictly validates segment consumption messages', () => {
    expect(parseTtsSynthesisConsumeRequest({
      action: 'tts_synthesis',
      sessionId: 'session-1',
      userId: 'user-1',
      eventKey: 'segment-1',
      characters: 42,
    })).not.toBeNull();
    expect(parseTtsSynthesisConsumeRequest({
      action: 'tts_synthesis', sessionId: 'session-1', userId: 'user-1',
      eventKey: 'segment-1', characters: 42, unexpected: true,
    })).toBeNull();
    expect(parseTtsSynthesisConsumeResponse({
      allowed: true, charged: true, idempotent: false, retryAfterMs: 0, usage: null,
    })).not.toBeNull();
  });

  it('strictly validates operation completion messages', () => {
    expect(parseComputeAdmissionTerminalRequest({
      operationId: 'op-1', state: 'succeeded',
    })).toEqual({ operationId: 'op-1', state: 'succeeded' });
    expect(parseComputeAdmissionTerminalRequest({
      operationId: 'op-1', state: 'running',
    })).toBeNull();
  });
});

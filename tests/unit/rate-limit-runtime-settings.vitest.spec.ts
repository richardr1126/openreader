import { describe, expect, test } from 'vitest';

import { RUNTIME_CONFIG_SCHEMA } from '../../src/lib/server/admin/settings';

describe('compute limit runtime config seed', () => {
  test('contains every compute area in one validated policy', () => {
    const policy = RUNTIME_CONFIG_SCHEMA.computeLimitPolicies.default;
    expect(Object.keys(policy.actions)).toEqual([
      'pdf_layout',
      'tts_playback',
      'tts_playback_plan',
      'tts_playback_export',
      'document_preview',
      'document_conversion',
      'account_export',
      'tts_synthesis',
    ]);
    expect(policy.actions.tts_synthesis.enabled).toBe(false);
    expect(policy.actions.tts_synthesis.usage).toContainEqual(expect.objectContaining({
      audience: 'authenticated',
      limit: 500_000,
      boundary: 'soft_unit',
    }));
  });
});

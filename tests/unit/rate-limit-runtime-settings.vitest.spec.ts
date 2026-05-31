import { describe, expect, test } from 'vitest';

import { RUNTIME_CONFIG_SCHEMA } from '../../src/lib/server/admin/settings';

describe('TTS rate limit runtime config seeds', () => {
  test('defaults disable TTS daily rate limiting', () => {
    expect(RUNTIME_CONFIG_SCHEMA.disableTtsRateLimit.default).toBe(true);
  });

  test('daily limit values are runtime defaults', () => {
    expect(RUNTIME_CONFIG_SCHEMA.ttsDailyLimitAnonymous.default).toBe(50_000);
    expect(RUNTIME_CONFIG_SCHEMA.ttsDailyLimitAuthenticated.default).toBe(500_000);
  });
});

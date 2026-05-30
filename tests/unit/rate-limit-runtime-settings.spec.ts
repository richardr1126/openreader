import { expect, test } from '@playwright/test';

import { RUNTIME_CONFIG_SCHEMA } from '../../src/lib/server/admin/settings';

test.describe('TTS rate limit runtime config seeds', () => {
  test('defaults disable TTS daily rate limiting', () => {
    expect(RUNTIME_CONFIG_SCHEMA.disableTtsRateLimit.default).toBe(true);
  });

  test('parses disable seed boolean values', () => {
    expect(RUNTIME_CONFIG_SCHEMA.disableTtsRateLimit.parseEnv('true')).toBe(true);
    expect(RUNTIME_CONFIG_SCHEMA.disableTtsRateLimit.parseEnv('false')).toBe(false);
    expect(RUNTIME_CONFIG_SCHEMA.disableTtsRateLimit.parseEnv('1')).toBe(true);
    expect(RUNTIME_CONFIG_SCHEMA.disableTtsRateLimit.parseEnv('0')).toBe(false);
  });

  test('daily limit values are runtime-only (no env seed vars)', () => {
    expect(RUNTIME_CONFIG_SCHEMA.ttsDailyLimitAnonymous.envVar).toBeUndefined();
    expect(RUNTIME_CONFIG_SCHEMA.ttsDailyLimitAuthenticated.envVar).toBeUndefined();
    expect(RUNTIME_CONFIG_SCHEMA.ttsIpDailyLimitAnonymous.envVar).toBeUndefined();
    expect(RUNTIME_CONFIG_SCHEMA.ttsIpDailyLimitAuthenticated.envVar).toBeUndefined();
    expect(RUNTIME_CONFIG_SCHEMA.ttsDailyLimitAnonymous.default).toBe(50_000);
    expect(RUNTIME_CONFIG_SCHEMA.ttsDailyLimitAuthenticated.default).toBe(500_000);
  });
});

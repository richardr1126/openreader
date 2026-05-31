import { describe, expect, test } from 'vitest';

import { RUNTIME_CONFIG_SCHEMA } from '../../src/lib/server/admin/settings';
import { assertUserSignupAllowed } from '../../src/lib/server/auth/signup-policy';

describe('enableUserSignups runtime config', () => {
  test('defaults to enabled', () => {
    expect(RUNTIME_CONFIG_SCHEMA.enableUserSignups.default).toBe(true);
  });
});

describe('signup policy enforcement', () => {
  test('allows new non-anonymous users when signups are enabled', () => {
    expect(() => assertUserSignupAllowed({ enableUserSignups: true, isAnonymous: false })).not.toThrow();
  });

  test('blocks new non-anonymous users when signups are disabled', () => {
    expect(() => assertUserSignupAllowed({ enableUserSignups: false, isAnonymous: false })).toThrow(
      /sign-ups are disabled/i,
    );
  });

  test('does not block anonymous-session user creation when signups are disabled', () => {
    expect(() => assertUserSignupAllowed({ enableUserSignups: false, isAnonymous: true })).not.toThrow();
  });
});

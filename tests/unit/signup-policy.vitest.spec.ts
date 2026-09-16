import { describe, expect, test } from 'vitest';

import { RUNTIME_CONFIG_SCHEMA } from '../../src/lib/server/admin/settings';
import { assertUserSignupAllowed, initialAccessStatus } from '../../src/lib/server/auth/signup-policy';

describe('signupPolicy runtime config', () => {
  test('defaults to open', () => {
    expect(RUNTIME_CONFIG_SCHEMA.signupPolicy.default).toBe('open');
  });
});

describe('signup policy enforcement', () => {
  test('allows new non-anonymous users when signups are enabled', () => {
    expect(() => assertUserSignupAllowed({ signupPolicy: 'open', isAnonymous: false })).not.toThrow();
  });

  test('blocks new non-anonymous users when signups are disabled', () => {
    expect(() => assertUserSignupAllowed({ signupPolicy: 'closed', isAnonymous: false })).toThrow(
      /sign-ups are disabled/i,
    );
  });

  test('does not block anonymous-session user creation when signups are disabled', () => {
    expect(() => assertUserSignupAllowed({ signupPolicy: 'closed', isAnonymous: true })).not.toThrow();
  });

  test('creates pending accounts only in approval mode', () => {
    expect(initialAccessStatus({ signupPolicy: 'approval' })).toBe('pending');
    expect(initialAccessStatus({ signupPolicy: 'open' })).toBe('active');
    expect(initialAccessStatus({ signupPolicy: 'approval', isAnonymous: true })).toBe('active');
  });
});

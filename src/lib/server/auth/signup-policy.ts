import { APIError } from 'better-auth/api';

import type { SignupPolicy } from '@/lib/server/admin/settings';

export function assertUserSignupAllowed(input: {
  signupPolicy: SignupPolicy;
  allowAnonymousSessions: boolean;
  isAnonymous?: boolean;
}): void {
  if (input.isAnonymous) {
    if (input.allowAnonymousSessions) return;
    throw new APIError('FORBIDDEN', {
      code: 'ANONYMOUS_SESSIONS_DISABLED',
      message: 'Guest sessions are disabled by the site administrator.',
    });
  }
  if (input.signupPolicy !== 'closed') return;
  throw new APIError('BAD_REQUEST', {
    message: 'New account sign-ups are disabled by the site administrator.',
  });
}

export function initialAccessStatus(input: {
  signupPolicy: SignupPolicy;
  isAnonymous?: boolean;
}): 'active' | 'pending' {
  if (input.isAnonymous || input.signupPolicy === 'open') return 'active';
  return 'pending';
}

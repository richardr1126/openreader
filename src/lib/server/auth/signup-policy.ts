import { APIError } from 'better-auth/api';

import type { SignupPolicy } from '@/lib/server/admin/settings';

export function assertUserSignupAllowed(input: {
  signupPolicy: SignupPolicy;
  isAnonymous?: boolean;
}): void {
  if (input.signupPolicy !== 'closed' || input.isAnonymous) return;
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

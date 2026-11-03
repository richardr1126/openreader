'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ButtonLink } from '@/components/ui';
import { LoadingSpinner } from '@/components/Spinner';
import { AuthCard, AuthFallback } from '@/components/auth/AuthCard';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { getAuthClient } from '@/lib/client/auth-client';

function VerifyEmailContent() {
  const query = useSearchParams();
  const token = query.get('token');
  const statusParam = query.get('status');
  const linkError = query.get('error');
  const { baseUrl } = useAuthConfig();
  const { accountEmailsEnabled } = useRuntimeConfig();
  const [state, setState] = useState<'working' | 'success' | 'error'>(statusParam === 'success' ? 'success' : token ? 'working' : 'error');

  useEffect(() => {
    if (!token || statusParam === 'success') return;
    void getAuthClient(baseUrl).verifyEmail({ query: { token, callbackURL: '/verify-email?status=success' } })
      .then((result) => setState(result.error ? 'error' : 'success'))
      .catch(() => setState('error'));
  }, [baseUrl, statusParam, token]);

  const displayState = linkError ? 'error' : state;
  return (
    <AuthCard
      title={displayState === 'working' ? 'Verifying your email' : displayState === 'success' ? 'Email verified' : 'Link unavailable'}
      description={!accountEmailsEnabled ? 'Account email actions are disabled on this OpenReader instance.' : displayState === 'working' ? 'This should only take a moment.' : displayState === 'success' ? 'Your address is confirmed. Sign in to continue reading.' : 'This verification link is invalid, expired, or has already been used.'}
    >
      {displayState === 'working' ? <LoadingSpinner className="mx-auto h-6 w-6 text-soft" /> : (
        <div className="space-y-2">
          <ButtonLink href="/signin" variant="primary" className="w-full">Sign in</ButtonLink>
          {displayState === 'error' && <ButtonLink href="/signin" variant="secondary" className="w-full">Resend from sign in</ButtonLink>}
        </div>
      )}
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  return <Suspense fallback={<AuthFallback />}><VerifyEmailContent /></Suspense>;
}

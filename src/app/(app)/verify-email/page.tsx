'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button, Surface } from '@/components/ui';
import { LoadingSpinner } from '@/components/Spinner';
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
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Surface elevation="3" className="w-full max-w-md p-6 text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-accent-wash text-xl text-accent">✉</div>
        <h1 className="mt-4 text-xl font-semibold text-foreground">
          {displayState === 'working' ? 'Verifying your email' : displayState === 'success' ? 'Email verified' : 'Link unavailable'}
        </h1>
        <p className="mt-2 text-sm text-soft">
          {!accountEmailsEnabled ? 'Account email actions are disabled on this OpenReader instance.' : displayState === 'working' ? 'This should only take a moment.' : displayState === 'success' ? 'Your address is confirmed. Sign in to continue reading.' : 'This verification link is invalid, expired, or has already been used.'}
        </p>
        {displayState === 'working' ? <LoadingSpinner className="mx-auto mt-5 h-6 w-6" /> : (
          <div className="mt-6 flex justify-center gap-2">
            <Link href="/signin"><Button variant="primary" size="md">Sign in</Button></Link>
            {displayState === 'error' && <Link href="/signin"><Button variant="outline" size="md">Resend from sign in</Button></Link>}
          </div>
        )}
      </Surface>
    </div>
  );
}

export default function VerifyEmailPage() {
  return <Suspense fallback={<div className="min-h-screen grid place-items-center bg-background"><LoadingSpinner className="h-8 w-8" /></div>}><VerifyEmailContent /></Suspense>;
}

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Field, Input, Surface } from '@/components/ui';
import { LoadingSpinner } from '@/components/Spinner';
import { MailIcon } from '@/components/icons/Icons';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { getAuthClient } from '@/lib/client/auth-client';

export default function ForgotPasswordPage() {
  const { baseUrl } = useAuthConfig();
  const { accountEmailsEnabled } = useRuntimeConfig();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim()) return;
    setLoading(true);
    setError(null);
    try {
      // The acknowledgement is deliberately generic for known and unknown addresses.
      const result = await getAuthClient(baseUrl).requestPasswordReset({
        email: email.trim(),
        redirectTo: '/reset-password',
      });
      if (result.error) throw new Error(result.error.message || 'Password reset request failed');
      setSubmitted(true);
    } catch {
      setError('Unable to send a reset email right now. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Surface elevation="3" className="w-full max-w-md p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">Account recovery</p>
        <h1 className="mt-2 text-xl font-semibold text-foreground">Reset your password</h1>
        {!accountEmailsEnabled ? (
          <p className="mt-3 text-sm text-soft">Password recovery by email is not enabled on this OpenReader instance.</p>
        ) : submitted ? (
          <div className="mt-5 flex items-start gap-3 rounded-lg border border-accent-line bg-accent-wash p-4">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface text-accent">
              <MailIcon className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">Check your email</p>
              <p className="mt-1 text-sm text-soft">If an account exists for that address, a reset link is on its way. It expires in one hour.</p>
            </div>
          </div>
        ) : (
          <>
            <p className="mt-1 text-sm text-soft">Enter your account email and we’ll send a one-hour reset link.</p>
            {error && (
              <div className="mt-4 rounded-lg border border-danger bg-danger-wash p-3">
                <p className="text-sm text-danger">{error}</p>
              </div>
            )}
            <div className="mt-6 space-y-4">
              <Field label="Email">
                <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="me@example.com" controlSize="lg" autoComplete="email" />
              </Field>
              <Button className="w-full" variant="primary" size="md" disabled={loading || !email.trim()} onClick={submit}>
                {loading ? <LoadingSpinner className="h-4 w-4" /> : 'Send reset link'}
              </Button>
            </div>
          </>
        )}
        <div className="mt-6 border-t border-line-soft pt-4 text-center text-xs text-soft">
          <Link href="/signin" className="underline hover:text-foreground">Back to sign in</Link>
        </div>
      </Surface>
    </div>
  );
}

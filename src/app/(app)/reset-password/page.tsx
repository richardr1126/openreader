'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button, Field, Input, Surface } from '@/components/ui';
import { LoadingSpinner } from '@/components/Spinner';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { getAuthClient } from '@/lib/client/auth-client';

function ResetPasswordContent() {
  const query = useSearchParams();
  const token = query.get('token');
  const linkError = query.get('error');
  const { baseUrl } = useAuthConfig();
  const { accountEmailsEnabled } = useRuntimeConfig();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!token || password.length < 8 || password !== confirmation) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getAuthClient(baseUrl).resetPassword({ newPassword: password, token });
      if (result.error) throw new Error(result.error.message || 'Reset link is invalid or has expired.');
      setComplete(true);
    } catch {
      setError('This reset link is invalid, expired, or has already been used. Request a new one.');
    } finally {
      setLoading(false);
    }
  };

  const invalid = !accountEmailsEnabled || !token || Boolean(linkError);
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Surface elevation="3" className="w-full max-w-md p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">Account recovery</p>
        <h1 className="mt-2 text-xl font-semibold text-foreground">Choose a new password</h1>
        {complete ? (
          <div className="mt-5 rounded-lg border border-accent-line bg-accent-wash p-4">
            <p className="text-sm font-medium text-foreground">Password updated</p>
            <p className="mt-1 text-sm text-soft">Existing sessions were revoked. Sign in with your new password to continue.</p>
          </div>
        ) : invalid ? (
          <div className="mt-5 rounded-lg border border-danger bg-danger-wash p-4">
            <p className="text-sm text-danger">This reset link is invalid or expired.</p>
            <Link href="/forgot-password" className="mt-2 inline-block text-sm underline">Request a new link</Link>
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            {error && <p className="rounded-lg border border-danger bg-danger-wash p-3 text-sm text-danger">{error}</p>}
            <Field label="New password">
              <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} controlSize="lg" autoComplete="new-password" />
            </Field>
            <Field label="Confirm new password">
              <Input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} controlSize="lg" autoComplete="new-password" />
            </Field>
            <p className="text-xs text-soft">Use at least 8 characters. You’ll sign in again after the reset.</p>
            <Button className="w-full" variant="primary" size="md" disabled={loading || password.length < 8 || password !== confirmation} onClick={submit}>
              {loading ? <LoadingSpinner className="h-4 w-4" /> : 'Update password'}
            </Button>
          </div>
        )}
        <div className="mt-6 border-t border-line-soft pt-4 text-center text-xs text-soft"><Link href="/signin" className="underline hover:text-foreground">Sign in</Link></div>
      </Surface>
    </div>
  );
}

export default function ResetPasswordPage() {
  return <Suspense fallback={<div className="min-h-screen grid place-items-center bg-background"><LoadingSpinner className="h-8 w-8" /></div>}><ResetPasswordContent /></Suspense>;
}

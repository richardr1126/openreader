'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Button, Field, Input } from '@/components/ui';
import { AuthCard, AuthFallback, AuthFooter } from '@/components/auth/AuthCard';
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
  const signIn = <AuthFooter><p><Link href="/signin" className="underline hover:text-foreground">Sign in</Link></p></AuthFooter>;
  if (complete) {
    return <AuthCard title="Password updated" description="Existing sessions were revoked. Sign in with your new password to continue.">{signIn}</AuthCard>;
  }
  if (invalid) {
    return (
      <AuthCard title="Choose a new password" description={<span className="text-danger">This reset link is invalid or expired.</span>}>
        <p className="text-sm"><Link href="/forgot-password" className="underline">Request a new link</Link></p>
        {signIn}
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Choose a new password" description="Use at least 8 characters. You’ll sign in again after the reset.">
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label="New password">
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} controlSize="lg" autoComplete="new-password" />
        </Field>
        <Field label="Confirm new password">
          <Input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} controlSize="lg" autoComplete="new-password" />
        </Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Button type="submit" className="w-full" variant="primary" disabled={loading || password.length < 8 || password !== confirmation}>
          {loading ? 'Updating…' : 'Update password'}
        </Button>
      </form>
      {signIn}
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return <Suspense fallback={<AuthFallback />}><ResetPasswordContent /></Suspense>;
}

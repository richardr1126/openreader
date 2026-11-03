'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Field, Input } from '@/components/ui';
import { AuthCard, AuthFooter } from '@/components/auth/AuthCard';
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

  const back = <AuthFooter><p><Link href="/signin" className="underline hover:text-foreground">Back to sign in</Link></p></AuthFooter>;
  if (!accountEmailsEnabled) {
    return <AuthCard title="Reset your password" description="Password recovery by email is not enabled on this OpenReader instance.">{back}</AuthCard>;
  }
  if (submitted) {
    return <AuthCard title="Check your email" description="If an account exists for that address, a reset link is on its way. It expires in one hour.">{back}</AuthCard>;
  }
  return (
    <AuthCard title="Reset your password" description="We’ll email you a reset link that expires in one hour.">
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Field label="Email">
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="me@example.com" controlSize="lg" autoComplete="email" />
        </Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Button type="submit" className="w-full" variant="primary" disabled={loading || !email.trim()}>
          {loading ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
      {back}
    </AuthCard>
  );
}

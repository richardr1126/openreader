'use client';

import { useState, useEffect } from 'react';
import { Button, Input } from '@headlessui/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getAuthClient } from '@/lib/client/auth-client';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { LoadingSpinner } from '@/components/Spinner';

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { authEnabled, baseUrl } = useAuthConfig();

  useEffect(() => {
    if (!authEnabled) {
      router.push('/app');
    }
  }, [router, authEnabled]);

  const validateEmail = (email: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const handleSubmit = async () => {
    setError(null);

    if (!email.trim() || !validateEmail(email)) {
      setError('Please enter a valid email address');
      return;
    }

    setLoading(true);

    try {
      const client = getAuthClient(baseUrl);
      await client.requestPasswordReset({
        email: email.trim(),
        redirectTo: '/reset-password',
      });
      // Always show success to prevent user enumeration
      setSubmitted(true);
    } catch (err) {
      console.error('Forgot password error:', err);
      // Still show success message to prevent user enumeration
      setSubmitted(true);
    } finally {
      setLoading(false);
    }
  };

  if (!authEnabled) {
    return null;
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <div className="w-full max-w-md bg-base rounded-2xl shadow-xl p-6">
          <h1 className="text-xl font-semibold text-foreground">Check your email</h1>
          <p className="text-sm text-muted mt-1">
            If an account exists with <strong className="text-foreground">{email}</strong>, we&apos;ve sent a password reset link.
          </p>

          <div className="mt-6 p-3 bg-accent/10 border border-accent/30 rounded-lg">
            <p className="text-sm text-foreground">
              The link will expire in 1 hour. Check your spam folder if you don&apos;t see it.
            </p>
          </div>

          <div className="mt-6 space-y-3">
            <Button
              type="button"
              onClick={() => { setSubmitted(false); setEmail(''); }}
              className="w-full rounded-lg bg-background py-2 text-sm font-medium text-foreground
                       hover:bg-offbase focus:outline-none focus:ring-2 focus:ring-accent
                       focus:ring-offset-2 border border-offbase
                       transform transition-transform duration-200 hover:scale-[1.02]"
            >
              Try a different email
            </Button>
          </div>

          <div className="mt-6 pt-4 border-t border-offbase text-center">
            <p className="text-xs text-muted">
              <Link href="/signin" className="underline hover:text-foreground">
                Back to sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md bg-base rounded-2xl shadow-xl p-6">
        <h1 className="text-xl font-semibold text-foreground">Forgot your password?</h1>
        <p className="text-sm text-muted mt-1">
          Enter your email address and we&apos;ll send you a link to reset your password.
        </p>

        {error && (
          <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="mt-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Email</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
              placeholder="me@example.com"
              className="w-full rounded-lg bg-background py-2 px-3 text-foreground shadow-sm
                       focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          <Button
            type="submit"
            disabled={loading}
            onClick={handleSubmit}
            className="w-full rounded-lg bg-accent py-2 text-sm font-medium text-background
                     hover:bg-secondary-accent focus:outline-none focus:ring-2 focus:ring-accent
                     focus:ring-offset-2 disabled:opacity-50 transform transition-transform
                     duration-200 hover:scale-[1.02]"
          >
            {loading ? <LoadingSpinner className="w-4 h-4 mx-auto" /> : 'Send Reset Link'}
          </Button>
        </div>

        <div className="mt-6 pt-4 border-t border-offbase text-center">
          <p className="text-xs text-muted">
            Remember your password?{' '}
            <Link href="/signin" className="underline hover:text-foreground">
              Sign in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

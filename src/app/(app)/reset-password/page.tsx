'use client';

import { useState, useEffect, Suspense } from 'react';
import { Button, Input } from '@headlessui/react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getAuthClient } from '@/lib/client/auth-client';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { LoadingSpinner } from '@/components/Spinner';

function ResetPasswordContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { authEnabled, baseUrl } = useAuthConfig();

  useEffect(() => {
    if (!authEnabled) {
      router.push('/app');
    }
  }, [router, authEnabled]);

  const validatePassword = (password: string) => {
    const checks = {
      length: password.length >= 8,
      uppercase: /[A-Z]/.test(password),
      lowercase: /[a-z]/.test(password),
      number: /\d/.test(password),
      special: /[!@#$%^&*(),.?":{}|<>]/.test(password)
    };
    const strength = Object.values(checks).filter(Boolean).length;
    return { checks, strength };
  };

  const handleReset = async () => {
    setError(null);

    if (!token) {
      setError('Invalid or missing reset token. Please request a new password reset link.');
      return;
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    const { strength } = validatePassword(password);
    if (strength < 3) {
      setError('Password is too weak');
      return;
    }

    if (password !== passwordConfirmation) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);

    try {
      const client = getAuthClient(baseUrl);
      const result = await client.resetPassword({
        newPassword: password,
        token,
      });

      if (result.error) {
        const msg = result.error.message || 'Failed to reset password';
        if (msg.toLowerCase().includes('expired') || msg.toLowerCase().includes('invalid')) {
          setError('This reset link has expired or is invalid. Please request a new one.');
        } else {
          setError(msg);
        }
      } else {
        setSuccess(true);
      }
    } catch (err) {
      console.error('Reset password error:', err);
      setError('Unable to reset password. The link may have expired.');
    } finally {
      setLoading(false);
    }
  };

  if (!authEnabled) {
    return null;
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <div className="w-full max-w-md bg-base rounded-2xl shadow-xl p-6">
          <h1 className="text-xl font-semibold text-foreground">Password reset successful</h1>
          <p className="text-sm text-muted mt-1">
            Your password has been updated. You can now sign in with your new password.
          </p>

          <div className="mt-6">
            <Button
              type="button"
              onClick={() => router.push('/signin')}
              className="w-full rounded-lg bg-accent py-2 text-sm font-medium text-background
                       hover:bg-secondary-accent focus:outline-none focus:ring-2 focus:ring-accent
                       focus:ring-offset-2 transform transition-transform
                       duration-200 hover:scale-[1.02]"
            >
              Go to Sign In
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <div className="w-full max-w-md bg-base rounded-2xl shadow-xl p-6">
          <h1 className="text-xl font-semibold text-foreground">Invalid Reset Link</h1>
          <p className="text-sm text-muted mt-1">
            This password reset link is invalid or has expired.
          </p>

          <div className="mt-6 space-y-3">
            <Button
              type="button"
              onClick={() => router.push('/forgot-password')}
              className="w-full rounded-lg bg-accent py-2 text-sm font-medium text-background
                       hover:bg-secondary-accent focus:outline-none focus:ring-2 focus:ring-accent
                       focus:ring-offset-2 transform transition-transform
                       duration-200 hover:scale-[1.02]"
            >
              Request a New Link
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

  const { checks, strength } = validatePassword(password);
  const strengthLabels = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong'];
  const strengthColors = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-blue-500', 'bg-green-500'];

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-md bg-base rounded-2xl shadow-xl p-6">
        <h1 className="text-xl font-semibold text-foreground">Set new password</h1>
        <p className="text-sm text-muted mt-1">
          Enter your new password below.
        </p>

        {error && (
          <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="mt-6 space-y-4">
          {/* New Password */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">New Password</label>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                placeholder="New password"
                className="w-full rounded-lg bg-background py-2 px-3 pr-10 text-foreground shadow-sm
                         focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>

            {/* Password Strength */}
            {password && (
              <div className="mt-2 space-y-1">
                <div className="flex gap-1">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      className={`h-1 flex-1 rounded ${i < strength ? strengthColors[strength - 1] : 'bg-offbase'}`}
                    />
                  ))}
                </div>
                <p className={`text-xs ${strength >= 3 ? 'text-green-600' : 'text-red-600'}`}>
                  {strengthLabels[strength - 1] || 'Very Weak'}
                </p>
                <div className="text-xs space-y-0.5 text-muted">
                  {Object.entries(checks).map(([key, passed]) => (
                    <div key={key} className={`flex items-center gap-1 ${passed ? 'text-green-600' : ''}`}>
                      <span>{passed ? '\u2713' : '\u25CB'}</span>
                      <span>
                        {key === 'length' && 'At least 8 characters'}
                        {key === 'uppercase' && 'Uppercase letter'}
                        {key === 'lowercase' && 'Lowercase letter'}
                        {key === 'number' && 'Number'}
                        {key === 'special' && 'Special character'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Confirm Password */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Confirm Password</label>
            <Input
              type={showPassword ? 'text' : 'password'}
              value={passwordConfirmation}
              onChange={(e) => { setPasswordConfirmation(e.target.value); setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleReset(); }}
              placeholder="Confirm new password"
              className="w-full rounded-lg bg-background py-2 px-3 text-foreground shadow-sm
                       focus:outline-none focus:ring-2 focus:ring-accent"
            />
            {passwordConfirmation && password && (
              <p className={`text-xs mt-1 ${password === passwordConfirmation ? 'text-green-600' : 'text-red-600'}`}>
                {password === passwordConfirmation ? '\u2713 Passwords match' : '\u2717 Passwords do not match'}
              </p>
            )}
          </div>

          {/* Reset Button */}
          <Button
            type="submit"
            disabled={loading}
            onClick={handleReset}
            className="w-full rounded-lg bg-accent py-2 text-sm font-medium text-background
                     hover:bg-secondary-accent focus:outline-none focus:ring-2 focus:ring-accent
                     focus:ring-offset-2 disabled:opacity-50 transform transition-transform
                     duration-200 hover:scale-[1.02]"
          >
            {loading ? <LoadingSpinner className="w-4 h-4 mx-auto" /> : 'Reset Password'}
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-background">
        <LoadingSpinner className="w-8 h-8" />
      </div>
    }>
      <ResetPasswordContent />
    </Suspense>
  );
}

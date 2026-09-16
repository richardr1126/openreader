'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getAuthClient } from '@/lib/client/auth-client';
import { useAuthConfig, useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { showPrivacyModal } from '@/components/PrivacyModal';
import { LoadingSpinner } from '@/components/Spinner';
import { MailIcon } from '@/components/icons/Icons';
import { Button, ButtonLink, Field, IconButton, InlineButton, Input, Surface } from '@/components/ui';
import toast from 'react-hot-toast';

export default function SignUpPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [awaitingVerification, setAwaitingVerification] = useState(false);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const { baseUrl } = useAuthConfig();
  const { accountEmailsEnabled, signupPolicy } = useRuntimeConfig();
  const canSignUp = signupPolicy !== 'closed';
  const { refresh: refreshRateLimit } = useAuthRateLimit();

  const validateEmail = (email: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

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

  const handleSignUp = async () => {
    setError(null);
    if (!canSignUp) {
      setError('New account sign-ups are currently disabled by the site administrator.');
      return;
    }

    if (!email.trim() || !validateEmail(email)) {
      setError('Please enter a valid email address');
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
      const result = await client.signUp.email({
        email: email.trim(),
        password,
        name: email.trim().split('@')[0], // Use part of email as name
        callbackURL: '/verify-email?status=success',
      });

      if (result.error) {
        const errorMessage = result.error.message || 'An unknown error occurred';
        if (errorMessage.toLowerCase().includes('already exists')) {
          setError('An account with this email already exists');
        } else {
          setError(errorMessage);
        }
      } else {
        if (signupPolicy === 'approval') {
          setAwaitingApproval(true);
          return;
        }
        if (accountEmailsEnabled) {
          setAwaitingVerification(true);
          return;
        }
        // Auto sign in
        const signInResult = await client.signIn.email({ email: email.trim(), password });
        if (signInResult.error) {
          toast.success('Account created! Please sign in.');
          router.push('/signin');
        } else {
          await refreshRateLimit();
          toast.success('Account created successfully!');
          router.push('/app');
        }
      }
    } catch (err) {
      console.error('Signup error:', err);
      setError('Unable to sign up. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const resendVerification = async () => {
    setLoading(true);
    try {
      const result = await getAuthClient(baseUrl).sendVerificationEmail({
        email: email.trim(),
        callbackURL: '/verify-email?status=success',
      });
      if (result.error) throw new Error(result.error.message || 'Verification email request failed');
      toast.success('If verification is still needed, another email is on its way.');
    } catch {
      toast.error('Unable to resend the verification email right now. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (!canSignUp) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <Surface elevation="3" className="w-full max-w-md p-6">
          <h1 className="text-xl font-semibold text-foreground">Sign-ups unavailable</h1>
          <p className="text-sm text-soft mt-1">
            New account sign-ups are currently disabled by the site administrator.
          </p>
          <div className="mt-6 pt-4 border-t border-line-soft text-center">
            <p className="text-xs text-soft">
              Already have an account?{' '}
              <Link href="/signin" className="underline hover:text-foreground">
                Sign in
              </Link>
            </p>
          </div>
        </Surface>
      </div>
    );
  }

  if (awaitingVerification) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <Surface elevation="3" className="w-full max-w-md p-6 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-accent-wash text-accent">
            <MailIcon className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-xl font-semibold text-foreground">Check your email</h1>
          <p className="mt-2 text-sm text-soft">
            If <span className="font-medium text-foreground">{email.trim()}</span> can be registered, a one-hour verification link is on its way.
            If you already have an account, sign in or reset your password.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button variant="outline" size="md" disabled={loading} onClick={resendVerification}>Resend verification</Button>
            <ButtonLink href="/forgot-password" variant="outline" size="md">Reset password</ButtonLink>
            <ButtonLink href="/signin" variant="primary" size="md">Sign in</ButtonLink>
          </div>
        </Surface>
      </div>
    );
  }

  if (awaitingApproval) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-background">
        <Surface elevation="3" className="w-full max-w-md p-6 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-accent-wash text-accent">
            <MailIcon className="h-6 w-6" aria-hidden="true" />
          </div>
          <h1 className="mt-4 text-xl font-semibold text-foreground">Request received</h1>
          <p className="mt-2 text-sm text-soft">
            Your account is waiting for an administrator to approve access.
            {accountEmailsEnabled
              ? ' Check your email to verify your address as well. You can sign in once both steps are complete.'
              : ' You can sign in after it is approved.'}
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {accountEmailsEnabled ? <Button variant="outline" size="md" disabled={loading} onClick={resendVerification}>Resend verification</Button> : null}
            <ButtonLink href="/signin" variant="primary" size="md">Return to sign in</ButtonLink>
          </div>
        </Surface>
      </div>
    );
  }

  const { checks, strength } = validatePassword(password);
  const strengthLabels = ['Very Weak', 'Weak', 'Fair', 'Good', 'Strong'];
  const strengthColors = ['bg-danger', 'bg-danger', 'bg-accent', 'bg-accent', 'bg-accent'];

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Surface elevation="3" className="w-full max-w-md p-6">
        <h1 className="text-xl font-semibold text-foreground">Sign up</h1>
        <p className="text-sm text-soft mt-1">
          {signupPolicy === 'approval'
            ? 'Request an account to sync your reading across devices'
            : 'Sign up to sync your reading across devices'}
        </p>

        {error && (
          <div className="mt-4 p-3 bg-danger-wash border border-danger rounded-lg">
            <p className="text-sm text-danger">{error}</p>
          </div>
        )}

        <div className="mt-6 space-y-4">
          {/* Email */}
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="me@example.com"
              controlSize="lg"
            />
          </Field>

          {/* Password */}
          <Field label="Password">
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                controlSize="lg"
                className="pr-10"
              />
              <IconButton
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 h-7 w-7 -translate-y-1/2"
              >
                {showPassword ? '👁️' : '👁️‍🗨️'}
              </IconButton>
            </div>

            {/* Password Strength */}
            {password && (
              <div className="mt-2 space-y-1">
                <div className="flex gap-1">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div
                      key={i}
                      className={`h-1 flex-1 rounded ${i < strength ? strengthColors[strength - 1] : 'bg-surface-sunken'
                        }`}
                    />
                  ))}
                </div>
                <p className={`text-xs ${strength >= 3 ? 'text-accent' : 'text-danger'}`}>
                  {strengthLabels[strength - 1] || 'Very Weak'}
                </p>
                <div className="text-xs space-y-0.5 text-soft">
                  {Object.entries(checks).map(([key, passed]) => (
                    <div key={key} className={`flex items-center gap-1 ${passed ? 'text-accent' : ''}`}>
                      <span>{passed ? '✓' : '○'}</span>
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
          </Field>

          {/* Confirm Password */}
          <Field label="Confirm Password">
            <Input
              type={showPassword ? 'text' : 'password'}
              value={passwordConfirmation}
              onChange={(e) => setPasswordConfirmation(e.target.value)}
              placeholder="Confirm Password"
              controlSize="lg"
            />
            {passwordConfirmation && password && (
              <p className={`text-xs mt-1 ${password === passwordConfirmation ? 'text-accent' : 'text-danger'}`}>
                {password === passwordConfirmation ? '✓ Passwords match' : '✗ Passwords do not match'}
              </p>
            )}
          </Field>

          {/* Sign Up Button */}
          <Button
            type="submit"
            disabled={loading}
            onClick={handleSignUp}
            variant="primary"
            size="md"
            className="w-full"
          >
            {loading ? <LoadingSpinner className="w-4 h-4 mx-auto" /> : signupPolicy === 'approval' ? 'Request access' : 'Sign up'}
          </Button>
        </div>

        {/* Footer */}
        <div className="mt-6 pt-4 border-t border-line-soft text-center space-y-2">
          <p className="text-xs text-soft">
            Already have an account?{' '}
            <Link href="/signin" className="underline hover:text-foreground">
              Sign in
            </Link>
          </p>
          <p className="text-xs text-soft">
            By creating an account, you agree to our{' '}
            <InlineButton onClick={() => showPrivacyModal()}>
              Privacy Policy
            </InlineButton>
          </p>
        </div>
      </Surface>
    </div>
  );
}

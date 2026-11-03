'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getAuthClient } from '@/lib/client/auth-client';
import { useAuthConfig, useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { showPrivacyModal } from '@/components/PrivacyModal';
import { CheckIcon, CircleIcon, EyeIcon, XIcon } from '@/components/icons/Icons';
import { Button, ButtonLink, Field, IconButton, InlineButton, Input } from '@/components/ui';
import { AuthCard, AuthFallback, AuthFooter } from '@/components/auth/AuthCard';
import toast from 'react-hot-toast';

export default function SignUpPage() {
  return <Suspense fallback={<AuthFallback />}><SignUpContent /></Suspense>;
}

function SignUpContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isOAuthSignUp = searchParams.has('sig');
  const signInHref = isOAuthSignUp ? `/signin?${searchParams}` : '/signin';
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
        // OAuth's session-creation hook has already returned the validated
        // consent redirect. Avoid a second sign-in/navigation racing it.
        if (isOAuthSignUp) return;
        // Auto sign in
        const signInResult = await client.signIn.email({ email: email.trim(), password });
        if (signInResult.error) {
          toast.success('Account created! Please sign in.');
          router.push(signInHref);
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
      <AuthCard title="Sign-ups unavailable" description="New account sign-ups are currently disabled by the site administrator.">
        <AuthFooter>
          <p>Already have an account? <Link href={signInHref} className="underline hover:text-foreground">Sign in</Link></p>
        </AuthFooter>
      </AuthCard>
    );
  }

  if (awaitingVerification) {
    return (
      <AuthCard
        title="Check your email"
        description={<>If <span className="break-words font-medium text-foreground">{email.trim()}</span> can be registered, a one-hour verification link is on its way. If you already have an account, sign in or reset your password.</>}
      >
        <div className="space-y-2">
          <ButtonLink href={signInHref} variant="primary" className="w-full">Sign in</ButtonLink>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" disabled={loading} onClick={resendVerification}>Resend verification</Button>
            <ButtonLink href="/forgot-password" variant="secondary">Reset password</ButtonLink>
          </div>
        </div>
      </AuthCard>
    );
  }

  if (awaitingApproval) {
    return (
      <AuthCard
        title="Request received"
        description={<>Your account is waiting for an administrator to approve access.{accountEmailsEnabled
          ? ' Check your email to verify your address as well. You can sign in once both steps are complete.'
          : ' You can sign in after it is approved.'}</>}
      >
        <div className="space-y-2">
          <ButtonLink href={signInHref} variant="primary" className="w-full">Return to sign in</ButtonLink>
          {accountEmailsEnabled && <Button variant="secondary" className="w-full" disabled={loading} onClick={resendVerification}>Resend verification</Button>}
        </div>
      </AuthCard>
    );
  }

  const { checks, strength } = validatePassword(password);
  const strengthLabels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
  const checkLabels: Record<keyof typeof checks, string> = {
    length: 'At least 8 characters',
    uppercase: 'Uppercase letter',
    lowercase: 'Lowercase letter',
    number: 'Number',
    special: 'Special character',
  };

  return (
    <AuthCard
      title={signupPolicy === 'approval' ? 'Request access' : 'Sign up'}
      description={signupPolicy === 'approval' ? 'An administrator approves new accounts.' : undefined}
    >
      <form className="space-y-4" noValidate onSubmit={(event) => { event.preventDefault(); void handleSignUp(); }}>
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="me@example.com"
            controlSize="lg"
            autoComplete="email"
          />
        </Field>
        <Field label="Password">
          <div className="relative">
            <Input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              controlSize="lg"
              className="pr-10"
              autoComplete="new-password"
            />
            <IconButton
              type="button"
              aria-label="Show password"
              aria-pressed={showPassword}
              onClick={() => setShowPassword(!showPassword)}
              className={`absolute right-2 top-1/2 h-7 w-7 -translate-y-1/2 ${showPassword ? 'text-accent' : 'text-soft'}`}
            >
              <EyeIcon className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </div>
          {password && (
            <div className="mt-2 space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex flex-1 gap-1">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className={`h-1 flex-1 rounded ${i < strength ? (strength >= 3 ? 'bg-foreground' : 'bg-danger') : 'bg-line'}`} />
                  ))}
                </div>
                <p className={`text-xs ${strength >= 3 ? 'text-foreground' : 'text-danger'}`}>{strengthLabels[strength - 1] || 'Very weak'}</p>
              </div>
              <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-soft">
                {(Object.keys(checks) as (keyof typeof checks)[]).map((key) => (
                  <li key={key} className={`flex items-center gap-1 ${checks[key] ? 'text-foreground' : ''}`}>
                    {checks[key] ? <CheckIcon className="h-3 w-3 shrink-0" aria-hidden /> : <CircleIcon className="h-3 w-3 shrink-0" aria-hidden />}
                    <span>{checkLabels[key]}<span className="sr-only">{checks[key] ? ' (met)' : ' (not met)'}</span></span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Field>
        <Field label="Confirm password">
          <Input
            type={showPassword ? 'text' : 'password'}
            value={passwordConfirmation}
            onChange={(e) => setPasswordConfirmation(e.target.value)}
            placeholder="Confirm Password"
            controlSize="lg"
            autoComplete="new-password"
          />
          {passwordConfirmation && password && (
            <p className={`mt-1 flex items-center gap-1 text-xs ${password === passwordConfirmation ? 'text-foreground' : 'text-danger'}`}>
              {password === passwordConfirmation
                ? <><CheckIcon className="h-3 w-3 shrink-0" aria-hidden />Passwords match</>
                : <><XIcon className="h-3 w-3 shrink-0" aria-hidden />Passwords do not match</>}
            </p>
          )}
        </Field>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Button type="submit" disabled={loading} variant="primary" className="w-full">
          {loading ? 'Creating account…' : signupPolicy === 'approval' ? 'Request access' : 'Sign up'}
        </Button>
      </form>
      <AuthFooter>
        <p>Already have an account? <Link href={signInHref} className="underline hover:text-foreground">Sign in</Link></p>
        <p>By creating an account, you agree to our <InlineButton onClick={() => showPrivacyModal()}>Privacy Policy</InlineButton></p>
      </AuthFooter>
    </AuthCard>
  );
}

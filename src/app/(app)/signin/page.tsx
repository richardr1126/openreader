'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getAuthClient } from '@/lib/client/auth-client';
import { useAuthConfig, useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { showPrivacyModal } from '@/components/PrivacyModal';
import { GithubIcon, KeyIcon } from '@/components/icons/Icons';
import { LoadingSpinner } from '@/components/Spinner';
import { Button, Checkbox, Field, InlineButton, Input } from '@/components/ui';
import { AuthCard, AuthFallback, AuthFooter } from '@/components/auth/AuthCard';

function describeOAuthError(code: string): string {
  switch (code) {
    case 'account_not_linked':
      return 'An account with this email already exists but could not be linked '
        + 'automatically because its email address is not verified. Sign in with '
        + 'your password instead.';
    case 'ACCOUNT_PENDING_APPROVAL':
      return 'Your account is waiting for administrator approval.';
    case 'ACCOUNT_SUSPENDED':
      return 'Your account has been suspended by an administrator.';
    default:
      return 'Single sign-on failed. Please try again.';
  }
}

function SignInContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isOAuthSignIn = searchParams.has('sig');
  const returnTo = (() => {
    const value = searchParams.get('returnTo');
    if (!value || !value.startsWith('/oauth/device?')) return '/app';
    try {
      const url = new URL(value, 'http://localhost');
      return url.origin === 'http://localhost' && url.pathname === '/oauth/device' ? `${url.pathname}${url.search}` : '/app';
    } catch { return '/app'; }
  })();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loadingEmail, setLoadingEmail] = useState(false);
  const [loadingGithub, setLoadingGithub] = useState(false);
  const [loadingOidc, setLoadingOidc] = useState(false);
  const [loadingAnonymous, setLoadingAnonymous] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const sessionExpired = searchParams.get('reason') === 'expired';
  const [error, setError] = useState<string | null>(() => {
    const oauthError = searchParams.get('error');
    return oauthError ? describeOAuthError(oauthError) : null;
  });
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null);
  const [verificationNotice, setVerificationNotice] = useState<string | null>(null);
  const { baseUrl, githubAuthEnabled, oidcAuth } = useAuthConfig();
  const { accountEmailsEnabled, signupPolicy, allowAnonymousSessions } = useRuntimeConfig();
  const canSignUp = signupPolicy !== 'closed';
  const { refresh: refreshRateLimit } = useAuthRateLimit();

  const isAnyLoading = loadingEmail || loadingGithub || loadingOidc || loadingAnonymous;

  const validateEmail = (email: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const handleSignIn = async () => {
    setError(null);
    setVerificationEmail(null);
    setVerificationNotice(null);

    if (!email.trim() || !validateEmail(email)) {
      setError('Please enter a valid email address');
      return;
    }
    if (!password.trim()) {
      setError('Password is required');
      return;
    }

    setLoadingEmail(true);

    try {
      const client = getAuthClient(baseUrl);
      const result = await client.signIn.email({
        email: email.trim(),
        password,
        rememberMe
      });

      if (result.error) {
        const errorMessage = result.error.message || 'An unknown error occurred';
        if (accountEmailsEnabled && /not.?verified/i.test(errorMessage)) {
          setVerificationEmail(email.trim());
          setError('Verify your email before signing in. We sent a fresh one-hour link.');
        } else if (errorMessage.toLowerCase().includes('invalid') ||
          errorMessage.toLowerCase().includes('credentials')) {
          setError('Invalid email or password');
        } else {
          setError(errorMessage);
        }
      } else {
        // Immediately refresh rate-limit status so the banner clears without a full reload.
        // This is especially important when an anonymous user upgrades to an account.
        await refreshRateLimit();
        if (!isOAuthSignIn) router.push(returnTo);
      }
    } catch (err) {
      console.error('Sign in error:', err);
      setError('Unable to sign in. Please try again.');
    } finally {
      setLoadingEmail(false);
    }
  };

  const resendVerification = async () => {
    if (!verificationEmail) return;
    setLoadingEmail(true);
    setError(null);
    setVerificationNotice(null);
    try {
      const result = await getAuthClient(baseUrl).sendVerificationEmail({
        email: verificationEmail,
        callbackURL: '/verify-email?status=success',
      });
      if (result.error) throw new Error(result.error.message || 'Verification email request failed');
      setVerificationNotice('A new verification link was queued. Check your email.');
    } catch {
      setError('Unable to resend the verification email right now. Please try again.');
    } finally {
      setLoadingEmail(false);
    }
  };

  const handleGithubSignIn = async () => {
    setLoadingGithub(true);
    try {
      const client = getAuthClient(baseUrl);
      await client.signIn.social({
        provider: 'github',
        callbackURL: returnTo
      });
    } finally {
      setLoadingGithub(false);
    }
  };

  const handleOidcSignIn = async () => {
    if (!oidcAuth) return;
    setError(null);
    setLoadingOidc(true);
    try {
      const client = getAuthClient(baseUrl);
      const result = await client.signIn.social({
        provider: oidcAuth.providerId,
        callbackURL: returnTo,
        errorCallbackURL: '/signin',
      });
      if (result.error) {
        setError(result.error.message || 'Unable to connect. Please try again.');
      }
    } catch (err) {
      console.error('OIDC sign in error:', err);
      setError('Unable to connect. Please try again.');
    } finally {
      setLoadingOidc(false);
    }
  };

  const handleAnonymousContinue = async () => {
    setLoadingAnonymous(true);
    setError(null);
    try {
      const client = getAuthClient(baseUrl);
      const result = await client.signIn.anonymous();
      if (result.error) {
        setError(result.error.message || 'Unable to continue as a guest. Please try again.');
        return;
      }
      await refreshRateLimit();
      router.push('/app');
    } catch (e) {
      console.error('Anonymous sign-in failed:', e);
      setError('Unable to continue as a guest. Please try again.');
    } finally {
      setLoadingAnonymous(false);
    }
  };

  const hasAlternatives = githubAuthEnabled || !!oidcAuth || (allowAnonymousSessions && !isOAuthSignIn);

  return (
    <AuthCard title={sessionExpired ? 'Session expired' : 'Sign in'} description={sessionExpired ? 'Sign in again to continue.' : undefined}>
      <form className="space-y-4" noValidate onSubmit={(event) => { event.preventDefault(); void handleSignIn(); }}>
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(null); }}
            placeholder="me@example.com"
            controlSize="lg"
            autoComplete="email"
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(null); }}
            placeholder="Password"
            controlSize="lg"
            autoComplete="current-password"
          />
        </Field>
        <div className="flex items-center justify-between gap-3">
          <label className="flex cursor-pointer items-center gap-2">
            <Checkbox checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
            <span className="text-sm text-foreground">Remember me</span>
          </label>
          {accountEmailsEnabled && (
            <Link href="/forgot-password" className="text-xs text-soft underline hover:text-foreground">Forgot password?</Link>
          )}
        </div>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        {verificationNotice && <p role="status" className="text-sm text-soft">{verificationNotice}</p>}
        {verificationEmail && (
          <Button type="button" variant="secondary" className="w-full" disabled={loadingEmail} onClick={resendVerification}>
            Resend verification email
          </Button>
        )}
        <Button type="submit" disabled={isAnyLoading} variant="primary" className="w-full">
          {loadingEmail ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      {hasAlternatives && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 text-xs text-soft" aria-hidden="true">
            <span className="flex-1 border-t border-line" />or<span className="flex-1 border-t border-line" />
          </div>
          {githubAuthEnabled && (
            <Button type="button" disabled={isAnyLoading} onClick={handleGithubSignIn} variant="secondary" className="w-full gap-2">
              {loadingGithub ? <LoadingSpinner className="h-4 w-4" /> : <><GithubIcon className="h-4 w-4" />Sign in with GitHub</>}
            </Button>
          )}
          {oidcAuth && (
            <Button type="button" disabled={isAnyLoading} onClick={handleOidcSignIn} variant="secondary" className="w-full gap-2">
              {loadingOidc ? <LoadingSpinner className="h-4 w-4" /> : <><KeyIcon className="h-4 w-4" />Sign in with {oidcAuth.providerName}</>}
            </Button>
          )}
          {allowAnonymousSessions && !isOAuthSignIn && (
            <Button type="button" disabled={isAnyLoading} onClick={handleAnonymousContinue} variant="secondary" className="w-full">
              {loadingAnonymous ? <LoadingSpinner className="h-4 w-4" /> : 'Continue as guest'}
            </Button>
          )}
        </div>
      )}

      <AuthFooter>
        {canSignUp && (
          <p>
            Don&apos;t have an account?{' '}
            <Link href={isOAuthSignIn ? `/signup?${searchParams}` : '/signup'} className="underline hover:text-foreground">Sign up</Link>
          </p>
        )}
        <p>By signing in, you agree to our <InlineButton onClick={() => showPrivacyModal()}>Privacy Policy</InlineButton></p>
      </AuthFooter>
    </AuthCard>
  );
}

export default function SignInPage() {
  return <Suspense fallback={<AuthFallback />}><SignInContent /></Suspense>;
}

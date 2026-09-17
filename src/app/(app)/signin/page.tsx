'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getAuthClient } from '@/lib/client/auth-client';
import { useAuthConfig, useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { showPrivacyModal } from '@/components/PrivacyModal';
import { GithubIcon, KeyIcon } from '@/components/icons/Icons';
import { LoadingSpinner } from '@/components/Spinner';
import { Button, Checkbox, Field, InlineButton, Input, Surface } from '@/components/ui';

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

function SearchParamsLoader({
  setSessionExpired,
  setError,
}: {
  setSessionExpired: (v: boolean) => void;
  setError: (v: string | null) => void;
}) {
  const searchParams = useSearchParams();
  useEffect(() => {
    const reason = searchParams.get('reason');
    setSessionExpired(reason === 'expired');
    const oauthError = searchParams.get('error');
    if (oauthError) setError(describeOAuthError(oauthError));
  }, [searchParams, setSessionExpired, setError]);
  return null;
}

function SignInContent() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loadingEmail, setLoadingEmail] = useState(false);
  const [loadingGithub, setLoadingGithub] = useState(false);
  const [loadingOidc, setLoadingOidc] = useState(false);
  const [loadingAnonymous, setLoadingAnonymous] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null);
  const [verificationNotice, setVerificationNotice] = useState<string | null>(null);
  const { baseUrl, allowAnonymousAuthSessions, githubAuthEnabled, oidcAuth } = useAuthConfig();
  const { accountEmailsEnabled, signupPolicy } = useRuntimeConfig();
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
        router.push('/app');
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
        callbackURL: '/app'
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
        callbackURL: '/app',
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
      await client.signIn.anonymous();
      await refreshRateLimit();
      router.push('/app');
    } catch (e) {
      console.error('Anonymous sign-in failed:', e);
      setError('Unable to continue anonymously. Please try again.');
    } finally {
      setLoadingAnonymous(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Suspense fallback={null}>
        <SearchParamsLoader setSessionExpired={setSessionExpired} setError={setError} />
      </Suspense>

        <Surface elevation="3" className="w-full max-w-md p-6">
          <h1 className="text-xl font-semibold text-foreground">
            {sessionExpired ? 'Session Expired' : 'Sign in'}
          </h1>
          <p className="text-sm text-soft mt-1">
            {sessionExpired
              ? 'Please sign in again to continue'
              : 'Sign in to sync your data across devices'}
          </p>

        {/* Alerts */}
        {sessionExpired && (
          <div className="mt-4 p-3 bg-accent-wash border border-accent-line rounded-lg">
            <p className="text-sm text-accent ">
              Your session has expired. Please sign in again.
            </p>
          </div>
        )}

        {error && (
          <div className="mt-4 p-3 bg-danger-wash border border-danger rounded-lg">
            <p className="text-sm text-danger">{error}</p>
          </div>
        )}
        {verificationNotice && (
          <div className="mt-4 p-3 bg-accent-wash border border-accent-line rounded-lg">
            <p className="text-sm text-accent">{verificationNotice}</p>
          </div>
        )}
        {verificationEmail && (
          <Button type="button" variant="outline" size="sm" className="mt-3" disabled={loadingEmail} onClick={resendVerification}>
            Resend verification email
          </Button>
        )}

        <div className="mt-6 space-y-4">
          {/* Email */}
          <Field label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(null); }}
              placeholder="me@example.com"
              controlSize="lg"
            />
          </Field>

          {/* Password */}
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              placeholder="Password"
              controlSize="lg"
            />
          </Field>
          {accountEmailsEnabled && (
            <div className="-mt-2 text-right">
              <Link href="/forgot-password" className="text-xs text-soft underline hover:text-foreground">Forgot password?</Link>
            </div>
          )}

          {/* Remember Me */}
          <label className="flex items-center gap-2 cursor-pointer">
            <Checkbox
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
            />
            <span className="text-sm text-foreground">Remember me</span>
          </label>

          {/* Sign in button */}
          <Button
            type="submit"
            disabled={isAnyLoading}
            onClick={handleSignIn}
            variant="primary"
            size="md"
            className="w-full"
          >
            {loadingEmail ? <LoadingSpinner className="w-4 h-4 mx-auto" /> : 'Sign in'}
          </Button>

          {/* GitHub */}
          {githubAuthEnabled && (
          <Button
            type="button"
            disabled={isAnyLoading}
            onClick={handleGithubSignIn}
            variant="outline"
            size="md"
            className="w-full gap-2"
          >
            {loadingGithub ? (
              <LoadingSpinner className="w-4 h-4" />
            ) : (
              <>
                <GithubIcon className="w-4 h-4" />
                Sign in with GitHub
              </>
            )}
          </Button>
          )}

          {/* Generic OIDC */}
          {oidcAuth && (
          <Button
            type="button"
            disabled={isAnyLoading}
            onClick={handleOidcSignIn}
            variant="outline"
            size="md"
            className="w-full gap-2"
          >
            {loadingOidc ? (
              <LoadingSpinner className="w-4 h-4" />
            ) : (
              <>
                <KeyIcon className="w-4 h-4" />
                Sign in with {oidcAuth.providerName}
              </>
            )}
          </Button>
          )}

          {/* Anonymous */}
          {allowAnonymousAuthSessions && (
            <Button
              type="button"
              disabled={isAnyLoading}
              onClick={handleAnonymousContinue}
              variant="outline"
              size="md"
              className="w-full"
            >
              {loadingAnonymous ? <LoadingSpinner className="w-4 h-4 mx-auto" /> : 'Continue anonymously'}
            </Button>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 pt-4 border-t border-line-soft text-center space-y-2">
          {canSignUp && (
            <p className="text-xs text-soft">
              Don&apos;t have an account?{' '}
              <Link href="/signup" className="underline hover:text-foreground">
                Sign up
              </Link>
            </p>
          )}
          <p className="text-xs text-soft">
            By signing in, you agree to our{' '}
            <InlineButton onClick={() => showPrivacyModal()}>
              Privacy Policy
            </InlineButton>
          </p>
        </div>
      </Surface>
    </div>
  );
}

export default function SignInPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-background">
        <LoadingSpinner className="w-8 h-8" />
      </div>
    }>
      <SignInContent />
    </Suspense>
  );
}

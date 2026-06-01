'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getAuthClient } from '@/lib/client/auth-client';
import { useAuthConfig, useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { useFeatureFlag } from '@/contexts/RuntimeConfigContext';
import { showPrivacyModal } from '@/components/PrivacyModal';
import { GithubIcon } from '@/components/icons/Icons';
import { LoadingSpinner } from '@/components/Spinner';
import { Button, Field, Input, Surface } from '@/components/ui';

function SessionExpiredLoader({ setSessionExpired }: { setSessionExpired: (v: boolean) => void }) {
  const searchParams = useSearchParams();
  useEffect(() => {
    const reason = searchParams.get('reason');
    setSessionExpired(reason === 'expired');
  }, [searchParams, setSessionExpired]);
  return null;
}

function SignInContent() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loadingEmail, setLoadingEmail] = useState(false);
  const [loadingGithub, setLoadingGithub] = useState(false);
  const [loadingAnonymous, setLoadingAnonymous] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { baseUrl, allowAnonymousAuthSessions, githubAuthEnabled } = useAuthConfig();
  const enableUserSignups = useFeatureFlag('enableUserSignups');
  const { refresh: refreshRateLimit } = useAuthRateLimit();

  const isAnyLoading = loadingEmail || loadingGithub || loadingAnonymous;

  const validateEmail = (email: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  };

  const handleSignIn = async () => {
    setError(null);

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
        if (errorMessage.toLowerCase().includes('invalid') ||
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
      setError('Unable to connect. Please try again.');
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
        <SessionExpiredLoader setSessionExpired={setSessionExpired} />
      </Suspense>

        <Surface elevation="3" className="w-full max-w-md p-6">
          <h1 className="text-xl font-semibold text-foreground">
            {sessionExpired ? 'Session Expired' : 'Connect Account'}
          </h1>
          <p className="text-sm text-soft mt-1">
            {sessionExpired
              ? 'Please sign in again to continue'
              : 'Connect an email account to sync your data across devices'}
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

          {/* Remember Me */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="rounded border-muted text-accent focus:ring-accent-line"
            />
            <span className="text-sm text-foreground">Remember me</span>
          </label>

          {/* Connect Button */}
          <Button
            type="submit"
            disabled={isAnyLoading}
            onClick={handleSignIn}
            variant="primary"
            size="md"
            className="w-full"
          >
            {loadingEmail ? <LoadingSpinner className="w-4 h-4 mx-auto" /> : 'Connect'}
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
          {enableUserSignups && (
            <p className="text-xs text-soft">
              Don&apos;t have an account?{' '}
              <Link href="/signup" className="underline hover:text-foreground">
                Sign up
              </Link>
            </p>
          )}
          <p className="text-xs text-soft">
            By signing in, you agree to our{' '}
            <button
              onClick={() => showPrivacyModal()}
              className="underline hover:text-foreground"
            >
              Privacy Policy
            </button>
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

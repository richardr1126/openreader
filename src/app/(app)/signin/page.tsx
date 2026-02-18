'use client';

import { useState, useEffect, Suspense } from 'react';
import { Button, Input } from '@headlessui/react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getAuthClient } from '@/lib/client/auth-client';
import { useAuthConfig, useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { showPrivacyModal } from '@/components/PrivacyModal';
import { GithubIcon } from '@/components/icons/Icons';
import { LoadingSpinner } from '@/components/Spinner';

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
  const { authEnabled, baseUrl, allowAnonymousAuthSessions, githubAuthEnabled } = useAuthConfig();
  const { refresh: refreshRateLimit } = useAuthRateLimit();

  const isAnyLoading = loadingEmail || loadingGithub || loadingAnonymous;

  // Check if auth is enabled, redirect home if not
  useEffect(() => {
    if (!authEnabled) {
      router.push('/app');
    }
  }, [router, authEnabled]);

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

  if (!authEnabled) {
    return null;
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Suspense fallback={null}>
        <SessionExpiredLoader setSessionExpired={setSessionExpired} />
      </Suspense>

        <div className="w-full max-w-md bg-base rounded-2xl shadow-xl p-6">
          <h1 className="text-xl font-semibold text-foreground">
            {sessionExpired ? 'Session Expired' : 'Connect Account'}
          </h1>
          <p className="text-sm text-muted mt-1">
            {sessionExpired
              ? 'Please sign in again to continue'
              : 'Connect an email account to sync your data across devices'}
          </p>

        {/* Alerts */}
        {sessionExpired && (
          <div className="mt-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
            <p className="text-sm text-amber-700 dark:text-amber-400">
              Your session has expired. Please sign in again.
            </p>
          </div>
        )}

        {error && (
          <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="mt-6 space-y-4">
          {/* Email */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Email</label>
            <Input
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(null); }}
              placeholder="me@example.com"
              className="w-full rounded-lg bg-background py-2 px-3 text-foreground shadow-sm 
                       focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          {/* Password */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Password</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              placeholder="Password"
              className="w-full rounded-lg bg-background py-2 px-3 text-foreground shadow-sm 
                       focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>

          {/* Remember Me */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="rounded border-muted text-accent focus:ring-accent"
            />
            <span className="text-sm text-foreground">Remember me</span>
          </label>

          {/* Connect Button */}
          <Button
            type="submit"
            disabled={isAnyLoading}
            onClick={handleSignIn}
            className="w-full rounded-lg bg-accent py-2 text-sm font-medium text-background 
                     hover:bg-secondary-accent focus:outline-none focus:ring-2 focus:ring-accent 
                     focus:ring-offset-2 disabled:opacity-50 transform transition-transform 
                     duration-200 hover:scale-[1.02]"
          >
            {loadingEmail ? <LoadingSpinner className="w-4 h-4 mx-auto" /> : 'Connect'}
          </Button>

          {/* GitHub */}
          {githubAuthEnabled && (
          <Button
            type="button"
            disabled={isAnyLoading}
            onClick={handleGithubSignIn}
            className="w-full rounded-lg bg-background py-2 text-sm font-medium text-foreground 
                     hover:bg-offbase focus:outline-none focus:ring-2 focus:ring-accent 
                     focus:ring-offset-2 disabled:opacity-50 border border-offbase 
                     transform transition-transform duration-200 hover:scale-[1.02] 
                     flex items-center justify-center gap-2"
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
              className="w-full rounded-lg bg-background py-2 text-sm font-medium text-foreground 
                     hover:bg-offbase focus:outline-none focus:ring-2 focus:ring-accent 
                     focus:ring-offset-2 disabled:opacity-50 border border-offbase 
                     transform transition-transform duration-200 hover:scale-[1.02]"
            >
              {loadingAnonymous ? <LoadingSpinner className="w-4 h-4 mx-auto" /> : 'Continue anonymously'}
            </Button>
          )}
        </div>

        {/* Footer */}
        <div className="mt-6 pt-4 border-t border-offbase text-center space-y-2">
          <p className="text-xs text-muted">
            Don&apos;t have an account?{' '}
            <Link href="/signup" className="underline hover:text-foreground">
              Sign up
            </Link>
          </p>
          <p className="text-xs text-muted">
            By signing in, you agree to our{' '}
            <button
              onClick={() => showPrivacyModal({ authEnabled })}
              className="underline hover:text-foreground"
            >
              Privacy Policy
            </button>
          </p>
        </div>
      </div>
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

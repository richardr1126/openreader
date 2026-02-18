'use client';

import { useEffect, useRef, useState, ReactNode } from 'react';
import type { BetterFetchError } from 'better-auth/react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthConfig, useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { getAuthClient } from '@/lib/client/auth-client';
import { LoadingSpinner } from '@/components/Spinner';

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

type ErrorInfo = { status?: number; message?: string };

function isBetterFetchError(input: unknown): input is BetterFetchError {
  if (!input || typeof input !== 'object') return false;
  const rec = input as Record<string, unknown>;
  return (
    input instanceof Error &&
    typeof rec.status === 'number' &&
    typeof rec.statusText === 'string' &&
    'error' in rec
  );
}

/**
 * Normalize different error shapes into a single `{ status, message }`.
 *
 * Handles:
 * - thrown Errors that may include `status`
 * - better-auth / better-fetch style endpoint returns: `{ data, error }`
 */
function getErrorInfo(input: unknown): ErrorInfo | null {
  if (!input) return null;

  if (isBetterFetchError(input)) {
    return {
      status: input.status,
      message: input.statusText || input.message,
    };
  }

  if (input instanceof Error) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = typeof (input as any).status === 'number' ? (input as any).status : undefined;
    return { status, message: input.message };
  }

  // Handle better-fetch style: { error: { status, message } } OR { error: string }
  if (typeof input === 'object') {
    const rec = input as Record<string, unknown>;
    if ('error' in rec && rec.error) {
      const err = rec.error;
      if (isBetterFetchError(err)) {
        return {
          status: err.status,
          message: err.statusText || err.message,
        };
      }
      if (typeof err === 'object' && err !== null) {
        const e = err as Record<string, unknown>;
        const status = typeof e.status === 'number' ? e.status : undefined;
        const message = typeof e.message === 'string' ? e.message : undefined;
        return { status, message };
      }
      return { message: typeof err === 'string' ? err : 'Request failed' };
    }

    const status = rec.status;
    const message = rec.message;
    const out: ErrorInfo = {};
    if (typeof status === 'number') out.status = status;
    if (typeof message === 'string') out.message = message;
    if (out.status !== undefined || out.message !== undefined) return out;
  }

  if (typeof input === 'string') return { message: input };

  return null;
}

function isRateLimited(info: ErrorInfo | null): boolean {
  if (!info) return false;
  if (info.status === 429) return true;
  // Fallback for cases where the server didn't return a numeric status.
  const msg = info.message || '';
  return /too\s+many\s+requests|rate\s*limit/i.test(msg);
}

export function AuthLoader({ children }: { children: ReactNode }) {
  const { authEnabled, baseUrl, allowAnonymousAuthSessions } = useAuthConfig();
  const { refresh: refreshRateLimit } = useAuthRateLimit();
  const { data: session, isPending, error: sessionError, refetch: refetchSession } = useAuthSession();
  const router = useRouter();
  const pathname = usePathname();
  const [isAutoLoggingIn, setIsAutoLoggingIn] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const attemptedForNullSessionRef = useRef(false);
  const clearingDisallowedAnonymousRef = useRef(false);
  const isAuthPage = pathname === '/signin' || pathname === '/signup';

  // If the auth base URL changes, re-run the bootstrap logic.
  useEffect(() => {
    attemptedForNullSessionRef.current = false;
    setBootstrapError(null);
    setIsRedirecting(false);
  }, [authEnabled, baseUrl, allowAnonymousAuthSessions, pathname]);

  useEffect(() => {
    const checkStatus = async () => {
      if (!authEnabled) return;
      if (isPending) return;

      if (session) {
        if (!allowAnonymousAuthSessions && session.user.isAnonymous) {
          if (clearingDisallowedAnonymousRef.current) return;
          clearingDisallowedAnonymousRef.current = true;
          try {
            setIsRedirecting(true);
            const client = getAuthClient(baseUrl);
            await client.signOut();
          } catch (err) {
            console.error('[AuthLoader] failed to clear disallowed anonymous session', err);
          } finally {
            clearingDisallowedAnonymousRef.current = false;
          }
          router.replace('/signin');
          return;
        }

        clearingDisallowedAnonymousRef.current = false;
        attemptedForNullSessionRef.current = false;
        setBootstrapError(null);
        return;
      }

      if (!allowAnonymousAuthSessions) {
        setIsAutoLoggingIn(false);
        setBootstrapError(null);
        if (!isAuthPage) {
          setIsRedirecting(true);
          router.replace('/signin');
        }
        return;
      }

      // Avoid double-calling anonymous sign-in (e.g. React strict mode).
      if (attemptedForNullSessionRef.current) return;
      attemptedForNullSessionRef.current = true;

      setIsAutoLoggingIn(true);
      setBootstrapError(null);

      try {
        const client = getAuthClient(baseUrl);

        // In Playwright/`next start` we sometimes hit 429s on anonymous sign-in.
        // Keep using better-auth client so its session hook updates correctly,
        // but add retry/backoff around the call.
        const maxAttempts = 6;
        const baseDelayMs = 500;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const attemptTag = `[AuthLoader] better-auth signIn.anonymous attempt ${attempt}/${maxAttempts}`;
          try {
            console.info(attemptTag);
            const result = await client.signIn.anonymous();
            const info = getErrorInfo(result);
            if (info) {
              // better-auth client endpoints often do NOT throw; they return { data, error }.
              // Convert that into a thrown error so our retry/backoff logic works.
              const e = new Error(info.message || 'Anonymous sign-in failed');
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (e as any).status = info.status;
              console.warn(`${attemptTag} (non-throwing error response)`, info);
              throw e;
            }

            console.info(`${attemptTag} (success)`, result ? { hasResult: true } : { hasResult: false });

            // In some environments (notably Playwright against `next start`),
            // the session signal does not immediately update after setting the
            // session cookie. Force an explicit session refetch.
            if (typeof refetchSession === 'function') {
              console.info('[AuthLoader] refetching session after anonymous sign-in');
              await refetchSession();
            }

            // Give React a moment to observe the updated session.
            await sleep(50);
            break;
          } catch (err) {
            const info = getErrorInfo(err);
            console.warn(`${attemptTag} (failed)`, info ?? undefined);
            console.warn(err);

            if (isRateLimited(info) && attempt < maxAttempts) {
              // better-auth doesn't currently expose Retry-After headers here;
              // fall back to exponential backoff.
              const delayMs = Math.min(10_000, baseDelayMs * Math.pow(2, attempt - 1));
              console.warn(`${attemptTag} rate-limited; waiting ${delayMs}ms before retry`);
              await sleep(delayMs);
              continue;
            }

            throw err;
          }
        }

        await refreshRateLimit();
      } catch (err) {
        console.error('[AuthLoader] auto-login failed', err);
        setBootstrapError('Unable to start an anonymous session (rate limited or network error).');
      } finally {
        setIsAutoLoggingIn(false);
      }
    };

    checkStatus();
  }, [
    session,
    isPending,
    authEnabled,
    baseUrl,
    allowAnonymousAuthSessions,
    refreshRateLimit,
    refetchSession,
    retryNonce,
    isAuthPage,
    router,
  ]);

  useEffect(() => {
    if (!authEnabled) return;
    if (sessionError) {
      console.warn('[AuthLoader] useSession error', sessionError);
    }
  }, [authEnabled, sessionError]);

  const shouldBlockForProtectedNoSession =
    authEnabled && !allowAnonymousAuthSessions && !isAuthPage && !session;
  const shouldBlockForDisallowedAnonymous =
    authEnabled && !allowAnonymousAuthSessions && Boolean(session?.user?.isAnonymous);
  const isLoading = authEnabled && (
    (allowAnonymousAuthSessions && (isPending || isAutoLoggingIn || !session)) ||
    (!allowAnonymousAuthSessions && !isAuthPage && (
      isPending || isRedirecting || shouldBlockForProtectedNoSession || shouldBlockForDisallowedAnonymous
    ))
  );

  if (isLoading) {
    return (
      <div className="fixed inset-0 bg-base z-50 flex flex-col items-center justify-center gap-4">
        <LoadingSpinner className="w-8 h-8 text-accent" />
        {bootstrapError ? (
          <div className="flex flex-col items-center gap-3">
            <p className="text-sm text-muted text-center">{bootstrapError}</p>
            <button
              type="button"
              onClick={() => {
                attemptedForNullSessionRef.current = false;
                setBootstrapError(null);
                setRetryNonce((v) => v + 1);
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-background hover:bg-secondary-accent focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2"
            >
              Retry
            </button>
          </div>
        ) : (
          <p className="text-sm text-muted animate-pulse">
            {isAutoLoggingIn ? 'Starting anonymous session...' : 'Loading...'}
          </p>
        )}
      </div>
    );
  }

  return <>{children}</>;
}

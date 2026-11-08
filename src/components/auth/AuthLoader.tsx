'use client';

import { useEffect, useRef, ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useSessionQueryReset } from '@/hooks/useSessionQueryReset';
import { getAuthClient } from '@/lib/client/auth-client';
import { signInPathFor } from '@/lib/shared/sign-in-return';

export function AuthLoader({ children }: { children: ReactNode }) {
  const { baseUrl } = useAuthConfig();
  const { allowAnonymousSessions } = useRuntimeConfig();
  const { data: session, isPending, error: sessionError, refetch: refetchSession } = useAuthSession();
  // Evict a previous session's user-scoped query cache when the active user changes.
  useSessionQueryReset();
  const router = useRouter();
  const pathname = usePathname();
  const clearingDisallowedAnonymousRef = useRef(false);
  const isAuthPage = pathname === '/signin'
    || pathname === '/signup'
    || pathname === '/verify-email'
    || pathname === '/forgot-password'
    || pathname === '/reset-password'
    // These explain signing in themselves and keep the request in their link.
    || pathname.startsWith('/oauth/')
    || pathname.startsWith('/audiobooks/');
  const isDisallowedGuest = !allowAnonymousSessions && Boolean(session?.user.isAnonymous);

  useEffect(() => {
    if (isPending) return;

    if (isDisallowedGuest) {
      if (clearingDisallowedAnonymousRef.current) return;
      clearingDisallowedAnonymousRef.current = true;
      void getAuthClient(baseUrl).signOut()
        .catch((err) => console.error('[AuthLoader] failed to clear disallowed anonymous session', err))
        .finally(() => {
          clearingDisallowedAnonymousRef.current = false;
          if (!isAuthPage) router.replace(signInPathFor(pathname));
        });
      return;
    }

    if (session || isAuthPage) return;

    // The session hook can still report `null` just after a sign-in in this tab
    // navigates here, so ask the server before sending anyone back to sign in.
    let cancelled = false;
    void getAuthClient(baseUrl).getSession()
      .then((existing) => existing.data?.session ?? null)
      .catch(() => null)
      .then((existing) => {
        if (cancelled) return;
        if (existing) void refetchSession();
        else router.replace(signInPathFor(pathname));
      });
    return () => { cancelled = true; };
  }, [session, isPending, isDisallowedGuest, isAuthPage, baseUrl, pathname, refetchSession, router]);

  useEffect(() => {
    if (sessionError) {
      console.warn('[AuthLoader] useSession error', sessionError);
    }
  }, [sessionError]);

  if (!isAuthPage && (!session || isDisallowedGuest)) return null;

  return <>{children}</>;
}

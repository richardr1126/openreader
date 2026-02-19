'use client';

import { useMemo } from 'react';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { getAuthClient } from '@/lib/client/auth-client';

type SessionHookResult = ReturnType<ReturnType<typeof getAuthClient>['useSession']>;

/** Stable empty result returned when auth is disabled. */
const EMPTY_SESSION: SessionHookResult = {
  data: null,
  isPending: false,
  isRefetching: false,
  // better-auth types use BetterFetchError | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: null as any,
  refetch: async () => { },
};

/** Stub client whose useSession() always returns the empty shape. */
const STUB_CLIENT = { useSession: () => EMPTY_SESSION } as ReturnType<typeof getAuthClient>;

/**
 * Hook for session that uses the correct baseUrl from context.
 * A stub client is used when auth is disabled so that useSession()
 * is always called unconditionally (Rules of Hooks).
 */
export function useAuthSession() {
  const { baseUrl, authEnabled } = useAuthConfig();

  const client = useMemo(() => {
    if (!authEnabled || !baseUrl) return STUB_CLIENT;
    return getAuthClient(baseUrl);
  }, [baseUrl, authEnabled]);

  return client.useSession();
}


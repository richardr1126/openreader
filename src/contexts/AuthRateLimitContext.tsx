'use client';

import React, { createContext, useContext, useEffect, useCallback, useMemo, useRef, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { coerceTimestampMs, nextUtcMidnightTimestampMs, nowTimestampMs } from '@/lib/shared/timestamps';
import { queryKeys } from '@/lib/client/query-keys';
import { getAuthClient } from '@/lib/client/auth-client';

export interface RateLimitStatus {
  allowed: boolean;
  currentCount: number;
  limit: number;
  remainingChars: number;
  resetTimeMs: number;
  userType: 'anonymous' | 'authenticated' | 'unauthenticated';
}

interface AuthRateLimitContextType {
  // Auth Config
  authBaseUrl: string | null;
  allowAnonymousAuthSessions: boolean;
  githubAuthEnabled: boolean;

  // Rate Limit
  status: RateLimitStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  isAtLimit: boolean;
  timeUntilReset: string;
  incrementCount: (charCount: number) => void;
  onTTSStart: () => void;
  onTTSComplete: () => void;
  triggerRateLimit: () => void;
}

const AuthRateLimitContext = createContext<AuthRateLimitContextType | null>(null);

export function useAuthRateLimit(): AuthRateLimitContextType {
  const context = useContext(AuthRateLimitContext);
  if (!context) {
    throw new Error('useAuthRateLimit must be used within an AuthRateLimitProvider');
  }
  return context;
}

export function useAuthConfig() {
  const { authBaseUrl, allowAnonymousAuthSessions, githubAuthEnabled } = useAuthRateLimit();
  return { baseUrl: authBaseUrl, allowAnonymousAuthSessions, githubAuthEnabled };
}

export function useRateLimit() {
  return useAuthRateLimit();
}

function calculateTimeUntilReset(resetTimeMs: number): string {
  const timeDiff = resetTimeMs - nowTimestampMs();

  if (timeDiff <= 0) {
    return 'Soon';
  }

  const hours = Math.floor(timeDiff / (1000 * 60 * 60));
  const minutes = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else {
    return `${minutes}m`;
  }
}

function parseRateLimitStatus(raw: unknown): RateLimitStatus | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;

  const userType = (() => {
    const value = data.userType;
    if (value === 'anonymous' || value === 'authenticated' || value === 'unauthenticated') return value;
    return 'unauthenticated';
  })();

  return {
    allowed: Boolean(data.allowed),
    currentCount: Number(data.currentCount ?? 0),
    limit: Number(data.limit ?? 0),
    remainingChars: Number(data.remainingChars ?? 0),
    resetTimeMs: coerceTimestampMs(data.resetTimeMs ?? data.resetTime, nextUtcMidnightTimestampMs()),
    userType,
  };
}

export function formatCharCount(count: number): string {
  if (count >= 1_000_000) {
    const m = count / 1_000_000;
    return `${parseFloat(m.toFixed(1))}M`;
  } else if (count >= 1_000) {
    const k = Math.round(count / 1_000);
    if (k >= 1_000) return '1M';
    return `${k}K`;
  }
  return count.toString();
}

interface AuthRateLimitProviderProps {
  children: ReactNode;
  authBaseUrl: string | null;
  allowAnonymousAuthSessions: boolean;
  githubAuthEnabled: boolean;
}

export function AuthRateLimitProvider({
  children,
  authBaseUrl,
  allowAnonymousAuthSessions,
  githubAuthEnabled,
}: AuthRateLimitProviderProps) {
  const queryClient = useQueryClient();
  // Read the session directly from the prop-provided base URL. We can't use
  // useAuthSession() here: it resolves the base URL via useAuthConfig() ->
  // useAuthRateLimit(), i.e. this provider's own context, which isn't
  // established yet during this render — that self-read threw
  // "useAuthRateLimit must be used within an AuthRateLimitProvider" on every SSR.
  const authClient = useMemo(() => getAuthClient(authBaseUrl), [authBaseUrl]);
  const { data: session } = authClient.useSession();
  // Scope the rate-limit cache per session so a previous user's quota cannot be
  // read after an account switch and useSessionQueryReset can evict it cleanly.
  const rateLimitQueryKey = useMemo(
    () => queryKeys.rateLimit(session?.user?.id ?? 'no-session'),
    [session?.user?.id],
  );

  const pendingTTSRef = useRef<number>(0);
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const {
    data: queryStatus,
    error: queryError,
    isPending,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: rateLimitQueryKey,
    queryFn: async () => {
      const response = await fetch('/api/rate-limit/status');
      if (!response.ok) {
        throw new Error(`Failed to fetch rate limit status: ${response.status}`);
      }
      return parseRateLimitStatus(await response.json());
    },
    enabled: true,
    retry: 0,
  });

  const status = queryStatus ?? null;
  const loading = isPending || isFetching;
  const error = queryError instanceof Error ? queryError.message : queryError ? 'Unknown error' : null;

  useEffect(() => {
    if (!queryError) return;
    console.error('Error fetching rate limit status:', queryError);
  }, [queryError]);

  const refresh = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const timeUntilReset = status ? calculateTimeUntilReset(status.resetTimeMs) : '';
  const isAtLimit = status ? (status.remainingChars <= 0 || !status.allowed) : false;

  const incrementCount = useCallback((charCount: number) => {
    queryClient.setQueryData<RateLimitStatus | null>(rateLimitQueryKey, (prevStatus) => {
      if (!prevStatus) return prevStatus;

      const newCurrentCount = prevStatus.currentCount + charCount;
      const newRemainingChars = Math.max(0, prevStatus.limit - newCurrentCount);

      return {
        ...prevStatus,
        currentCount: newCurrentCount,
        remainingChars: newRemainingChars,
        allowed: newRemainingChars > 0
      };
    });
  }, [queryClient, rateLimitQueryKey]);

  const onTTSStart = useCallback(() => {
    pendingTTSRef.current += 1;

    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
      updateTimeoutRef.current = null;
    }
  }, []);

  const onTTSComplete = useCallback(() => {
    pendingTTSRef.current = Math.max(0, pendingTTSRef.current - 1);

    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
      updateTimeoutRef.current = null;
    }

    if (pendingTTSRef.current === 0) {
      updateTimeoutRef.current = setTimeout(() => {
        void refresh();
        updateTimeoutRef.current = null;
      }, 1000);
    }
  }, [refresh]);

  useEffect(() => {
    return () => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
    };
  }, []);

  const contextValue: AuthRateLimitContextType = {
    authBaseUrl,
    allowAnonymousAuthSessions,
    githubAuthEnabled,
    status,
    loading,
    error,
    refresh,
    isAtLimit,
    timeUntilReset,
    incrementCount,
    onTTSStart,
    onTTSComplete,
    triggerRateLimit: () => {
      queryClient.setQueryData<RateLimitStatus | null>(rateLimitQueryKey, (prev) =>
        prev ? { ...prev, remainingChars: 0, allowed: false } : null,
      );
    },
  };

  return (
    <AuthRateLimitContext.Provider value={contextValue}>
      {children}
    </AuthRateLimitContext.Provider>
  );
}

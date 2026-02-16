'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';

export interface RateLimitStatus {
  allowed: boolean;
  currentCount: number;
  limit: number;
  remainingChars: number;
  resetTime: Date;
  userType: 'anonymous' | 'authenticated' | 'unauthenticated';
  authEnabled: boolean;
}

interface AuthRateLimitContextType {
  // Auth Config
  authEnabled: boolean;
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

// Re-export specific hooks for backward compatibility or convenience if needed
export function useAuthConfig() {
  const { authEnabled, authBaseUrl, allowAnonymousAuthSessions, githubAuthEnabled } = useAuthRateLimit();
  return { authEnabled, baseUrl: authBaseUrl, allowAnonymousAuthSessions, githubAuthEnabled };
}

export function useRateLimit() {
  return useAuthRateLimit();
}

function calculateTimeUntilReset(resetTime: Date): string {
  const now = new Date();
  const timeDiff = resetTime.getTime() - now.getTime();

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

export function formatCharCount(count: number): string {
  if (count >= 1_000_000) {
    const m = count / 1_000_000;
    // Show up to 1 decimal place, stripping trailing zeros (1.0 -> 1)
    return `${parseFloat(m.toFixed(1))}M`;
  } else if (count >= 1_000) {
    const k = Math.round(count / 1_000);
    // Handle edge case where rounding up reaches 1M (e.g., 999,999 -> 1000K -> 1M)
    if (k >= 1_000) return '1M';
    return `${k}K`;
  }
  return count.toString();
}

interface AuthRateLimitProviderProps {
  children: ReactNode;
  authEnabled: boolean;
  authBaseUrl: string | null;
  allowAnonymousAuthSessions: boolean;
  githubAuthEnabled: boolean;
}

export function AuthRateLimitProvider({
  children,
  authEnabled,
  authBaseUrl,
  allowAnonymousAuthSessions,
  githubAuthEnabled,
}: AuthRateLimitProviderProps) {
  const [status, setStatus] = useState<RateLimitStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track pending TTS operations to delay count updates
  const pendingTTSRef = useRef<number>(0);
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const fetchStatus = useCallback(async () => {
    // Skip if auth is not enabled
    if (!authEnabled) {
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setUTCDate(now.getUTCDate() + 1);
      tomorrow.setUTCHours(0, 0, 0, 0);

      setStatus({
        allowed: true,
        currentCount: 0,
        // Avoid Infinity to prevent JSON/serialization edge cases elsewhere.
        limit: Number.MAX_SAFE_INTEGER,
        remainingChars: Number.MAX_SAFE_INTEGER,
        resetTime: tomorrow,
        userType: 'unauthenticated',
        authEnabled: false
      });
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const response = await fetch('/api/rate-limit/status');

      if (!response.ok) {
        throw new Error(`Failed to fetch rate limit status: ${response.status}`);
      }

      const data = await response.json();

      setStatus({
        ...data,
        resetTime: new Date(data.resetTime)
      });
    } catch (err) {
      console.error('Error fetching rate limit status:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [authEnabled]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Calculate time until reset
  const timeUntilReset = status ? calculateTimeUntilReset(status.resetTime) : '';
  // Only treat the user as "at limit" when they are truly out of characters.
  // The server allows the final request that may cross the limit, then blocks subsequent ones.
  const isAtLimit = status ? (status.remainingChars <= 0 || !status.allowed) : false;

  // Increment count locally (for immediate UI feedback)
  const incrementCount = useCallback((charCount: number) => {
    setStatus(prevStatus => {
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
  }, []);

  // Called when a TTS request starts
  const onTTSStart = useCallback(() => {
    pendingTTSRef.current += 1;

    // Clear any existing timeout
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
      updateTimeoutRef.current = null;
    }
  }, []);

  // Called when a TTS request completes (success or error)
  const onTTSComplete = useCallback(() => {
    pendingTTSRef.current = Math.max(0, pendingTTSRef.current - 1);

    // Clear any existing timeout
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
      updateTimeoutRef.current = null;
    }

    // If no more pending requests, schedule an update
    if (pendingTTSRef.current === 0) {
      updateTimeoutRef.current = setTimeout(() => {
        fetchStatus();
        updateTimeoutRef.current = null;
      }, 1000); // Wait 1 second after completion to refresh
    }
  }, [fetchStatus]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
    };
  }, []);

  const contextValue: AuthRateLimitContextType = {
    authEnabled,
    authBaseUrl,
    allowAnonymousAuthSessions,
    githubAuthEnabled,
    status,
    loading,
    error,
    refresh: fetchStatus,
    isAtLimit,
    timeUntilReset,
    incrementCount,
    onTTSStart,
    onTTSComplete,
    triggerRateLimit: () => setStatus(prev => prev ? { ...prev, remainingChars: 0, allowed: false } : null)
  };

  return (
    <AuthRateLimitContext.Provider value={contextValue}>
      {children}
    </AuthRateLimitContext.Provider>
  );
}

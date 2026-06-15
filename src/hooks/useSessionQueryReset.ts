'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthSession } from '@/hooks/useAuthSession';

/**
 * User-scoped query domains keyed as `[domain, sessionId, ...]`. These hold
 * server-owned state and must never be read across sessions. Keys are already
 * session-scoped, so isolation holds by construction; this hook additionally
 * evicts a previous session's cached entries when the active user changes so
 * stale data cannot linger in memory after sign-out / account switch.
 */
const USER_SCOPED_DOMAINS = new Set([
  'documents',
  'preferences',
  'progress',
  'document-settings',
  'onboarding',
  'folders',
  'audiobook',
  'tts-manifest',
  'tts-voices',
  'parsed-document',
  'claim-counts',
  'rate-limit',
]);

/**
 * Removes user-scoped queries belonging to any session other than the active
 * one. Mount once near the app root, inside the QueryClientProvider.
 */
export function useSessionQueryReset(): void {
  const queryClient = useQueryClient();
  const { data: session, isPending } = useAuthSession();
  const sessionId = session?.user?.id ?? null;
  const previousRef = useRef<string | null>(null);

  useEffect(() => {
    if (isPending) return;
    if (previousRef.current === sessionId) return;
    previousRef.current = sessionId;

    queryClient.removeQueries({
      predicate: (query) => {
        const key = query.queryKey;
        if (!Array.isArray(key) || key.length < 2) return false;
        const [domain, keySessionId] = key as [unknown, unknown];
        if (typeof domain !== 'string' || !USER_SCOPED_DOMAINS.has(domain)) return false;
        return keySessionId !== sessionId;
      },
    });
  }, [queryClient, sessionId, isPending]);
}

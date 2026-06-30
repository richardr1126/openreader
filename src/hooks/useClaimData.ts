'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
import type { ClaimableCounts } from '@/types/client';

export const EMPTY_CLAIM_COUNTS: ClaimableCounts = {
  documents: 0,
  preferences: 0,
  progress: 0,
  documentSettings: 0,
  folders: 0,
  onboarding: 0,
};

function toCount(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function toClaimableCounts(value: unknown): ClaimableCounts {
  const rec = (value && typeof value === 'object') ? (value as Record<string, unknown>) : {};
  return {
    documents: toCount(rec.documents),
    preferences: toCount(rec.preferences),
    progress: toCount(rec.progress),
    documentSettings: toCount(rec.documentSettings),
    folders: toCount(rec.folders),
    onboarding: toCount(rec.onboarding),
  };
}

async function fetchClaimableCounts(signal?: AbortSignal): Promise<ClaimableCounts> {
  const response = await fetch('/api/user/claim', { signal });
  if (!response.ok) throw new Error('Failed to load claimable data');
  return toClaimableCounts(await response.json());
}

async function claimData(): Promise<ClaimableCounts> {
  const response = await fetch('/api/user/claim', { method: 'POST' });
  const data = await response.json().catch(() => null) as { claimed?: unknown; error?: string } | null;
  if (!response.ok) throw new Error(data?.error || 'Failed to claim data.');
  return toClaimableCounts(data?.claimed);
}

export function useClaimData(enabled = true) {
  const { data: session, isPending } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const key = queryKeys.claimCounts(sessionId);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => fetchClaimableCounts(signal),
    enabled: enabled && !isPending,
  });
  const mutation = useMutation({
    mutationFn: claimData,
    onSuccess: async () => {
      queryClient.setQueryData(key, EMPTY_CLAIM_COUNTS);
      await queryClient.invalidateQueries({
        predicate: (query) => {
          const queryKey = query.queryKey;
          return Array.isArray(queryKey)
            && queryKey[1] === sessionId
            && queryKey[0] !== 'claim-counts';
        },
      });
    },
  });
  return { query, mutation };
}

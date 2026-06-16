'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';

export type OnboardingState = { privacyAcceptedAtMs: number | null; lastSeenAppVersion: string | null };

async function fetchOnboarding(signal?: AbortSignal): Promise<OnboardingState> {
  const res = await fetch('/api/user/state/onboarding', { signal });
  if (!res.ok) throw new Error('Failed to load onboarding state');
  return ((await res.json()) as { onboarding: OnboardingState }).onboarding;
}

export function useOnboardingState() {
  const { data: session, isPending } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const key = queryKeys.onboarding(sessionId);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => fetchOnboarding(signal), enabled: !isPending });
  const mutation = useMutation({
    mutationFn: async (patch: { privacyAccepted?: boolean; lastSeenAppVersion?: string }) => {
      const res = await fetch('/api/user/state/onboarding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error('Failed to update onboarding state');
      return ((await res.json()) as { onboarding: OnboardingState }).onboarding;
    },
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<OnboardingState>(key);
      queryClient.setQueryData<OnboardingState>(key, (current) => ({
        privacyAcceptedAtMs: patch.privacyAccepted === undefined
          ? current?.privacyAcceptedAtMs ?? null
          : patch.privacyAccepted ? Date.now() : null,
        lastSeenAppVersion: patch.lastSeenAppVersion ?? current?.lastSeenAppVersion ?? null,
      }));
      return { previous };
    },
    onError: (_error, _patch, context) => queryClient.setQueryData(key, context?.previous),
    onSuccess: (data) => queryClient.setQueryData(key, data),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  return { query, mutation };
}

'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ClaimDataModal, { type ClaimableCounts } from '@/components/auth/ClaimDataModal';
import { PrivacyModal } from '@/components/PrivacyModal';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { postChangelogVersionCheck } from '@/lib/client/api/user-state';
import { scheduleChangelogCheck } from '@/lib/client/changelog-check';
import { createCoalescedAsyncRunner, resolveNextOnboardingStep } from '@/lib/client/onboarding-flow';
import { useOnboardingState } from '@/hooks/useOnboardingState';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/client/query-keys';

type OnboardingFlowContextValue = {
  changelogOpenSignal: number;
};

const OnboardingFlowContext = createContext<OnboardingFlowContextValue | null>(null);

const EMPTY_CLAIM_COUNTS: ClaimableCounts = {
  documents: 0,
  audiobooks: 0,
  preferences: 0,
  progress: 0,
  documentSettings: 0,
  folders: 0,
  onboarding: 0,
};

function toClaimableCounts(value: unknown): ClaimableCounts {
  const rec = (value && typeof value === 'object') ? (value as Record<string, unknown>) : {};
  return {
    documents: Number(rec.documents ?? 0),
    audiobooks: Number(rec.audiobooks ?? 0),
    preferences: Number(rec.preferences ?? 0),
    progress: Number(rec.progress ?? 0),
    documentSettings: Number(rec.documentSettings ?? 0),
    folders: Number(rec.folders ?? 0),
    onboarding: Number(rec.onboarding ?? 0),
  };
}

async function fetchClaimableCounts(): Promise<ClaimableCounts> {
  const res = await fetch('/api/user/claim', { method: 'GET' });
  if (!res.ok) {
    return EMPTY_CLAIM_COUNTS;
  }
  const data = await res.json();
  return toClaimableCounts(data);
}

export function OnboardingFlowProvider({ children }: { children: ReactNode }) {
  const { data: session, isPending: isSessionPending } = useAuthSession();
  const runtimeConfig = useRuntimeConfig();
  const user = session?.user as { id?: string; isAnonymous?: boolean } | undefined;
  const userId = user?.id ?? null;
  const isAnonymous = Boolean(user?.isAnonymous);
  const claimCountsQuery = useQuery({
    queryKey: queryKeys.claimCounts(userId ?? 'no-session'),
    queryFn: fetchClaimableCounts,
    enabled: Boolean(userId && !isAnonymous),
  });
  const refetchClaimCounts = claimCountsQuery.refetch;

  const { query: onboardingQuery } = useOnboardingState();
  const [activeBlockingModal, setActiveBlockingModal] = useState<'privacy' | 'claim' | null>(null);
  const [claimableCounts, setClaimableCounts] = useState<ClaimableCounts>(EMPTY_CLAIM_COUNTS);
  const [changelogOpenSignal, setChangelogOpenSignal] = useState(0);

  const pendingChangelogOpenRef = useRef(false);
  const claimDismissedUsersRef = useRef<Set<string>>(new Set());
  const changelogVersionCheckKeyRef = useRef<string | null>(null);
  const changelogVersionCheckInFlightRef = useRef<string | null>(null);

  const runOnceFlowRef = useRef<() => Promise<void>>(async () => {});

  const runFlow = useMemo(
    () => createCoalescedAsyncRunner(async () => {
      await runOnceFlowRef.current();
    }),
    [],
  );

  const runOnceFlow = useCallback(async () => {
    // Wait until the onboarding state has actually loaded before deciding whether
    // to show the privacy modal. Otherwise the not-yet-loaded query (data === undefined)
    // reads as "not accepted", the modal flashes on first paint, then closes once the
    // real state arrives.
    const onboardingData = onboardingQuery.data;
    if (onboardingData === undefined) {
      return;
    }

    const privacyRequired = true;
    const privacyAccepted = !privacyRequired || Boolean(onboardingData.privacyAcceptedAtMs);

    const isClaimEligible = Boolean(
      userId
      && !isAnonymous
      && !claimDismissedUsersRef.current.has(userId),
    );

    let claimCounts = EMPTY_CLAIM_COUNTS;
    let claimHasData = false;

    if (isClaimEligible) {
      claimCounts = (await refetchClaimCounts()).data ?? EMPTY_CLAIM_COUNTS;
      const total = claimCounts.documents
        + claimCounts.audiobooks
        + claimCounts.preferences
        + claimCounts.progress
        + claimCounts.documentSettings
        + claimCounts.folders
        + claimCounts.onboarding;
      claimHasData = total > 0;
      if (!claimHasData && userId) {
        claimDismissedUsersRef.current.add(userId);
      }
    }

    const nextStep = resolveNextOnboardingStep({
      privacyRequired,
      privacyAccepted,
      claimEligible: isClaimEligible,
      claimHasData,
      changelogPending: pendingChangelogOpenRef.current,
    });

    if (nextStep === 'privacy') {
      setActiveBlockingModal('privacy');
      return;
    }

    if (nextStep === 'claim') {
      setClaimableCounts(claimCounts);
      setActiveBlockingModal('claim');
      return;
    }

    setActiveBlockingModal(null);

    if (nextStep === 'changelog') {
      pendingChangelogOpenRef.current = false;
      setChangelogOpenSignal((value) => value + 1);
    }
  }, [isAnonymous, onboardingQuery.data, refetchClaimCounts, userId]);

  runOnceFlowRef.current = runOnceFlow;

  const handleClaimComplete = useCallback(() => {
    if (userId) {
      claimDismissedUsersRef.current.add(userId);
    }
    setActiveBlockingModal(null);
    void runFlow();
  }, [runFlow, userId]);

  const handlePrivacyAccepted = useCallback(() => {
    setActiveBlockingModal(null);
    void runFlow();
  }, [runFlow]);

  useEffect(() => {
    void runFlow();
  }, [isAnonymous, onboardingQuery.data, runFlow, userId]);

  useEffect(() => {
    const onPrivacyAccepted = () => {
      void runFlow();
    };
    window.addEventListener('openreader:privacyAccepted', onPrivacyAccepted);
    return () => {
      window.removeEventListener('openreader:privacyAccepted', onPrivacyAccepted);
    };
  }, [runFlow]);

  useEffect(() => {
    return scheduleChangelogCheck({
      isSessionPending,
      sessionUserId: userId,
      appVersion: runtimeConfig.appVersion,
      completedRef: changelogVersionCheckKeyRef,
      inFlightRef: changelogVersionCheckInFlightRef,
      postCheck: async (currentVersion) => postChangelogVersionCheck(currentVersion),
      onShouldOpen: () => {
        pendingChangelogOpenRef.current = true;
        void runFlow();
      },
      delayMs: 120,
      retryDelayMs: 400,
    });
  }, [isSessionPending, runFlow, runtimeConfig.appVersion, userId]);

  const contextValue = useMemo<OnboardingFlowContextValue>(() => ({
    changelogOpenSignal,
  }), [changelogOpenSignal]);

  return (
    <OnboardingFlowContext.Provider value={contextValue}>
      {children}
      <PrivacyModal
        isOpen={activeBlockingModal === 'privacy'}
        onAccept={handlePrivacyAccepted}
        onDismiss={() => { }}
      />
      <ClaimDataModal
        isOpen={activeBlockingModal === 'claim'}
        claimableCounts={claimableCounts}
        onDismiss={handleClaimComplete}
        onClaimed={handleClaimComplete}
      />
    </OnboardingFlowContext.Provider>
  );
}

export function useOnboardingFlow() {
  const context = useContext(OnboardingFlowContext);
  if (!context) {
    throw new Error('useOnboardingFlow must be used inside OnboardingFlowProvider');
  }
  return context;
}

'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ClaimDataModal from '@/components/auth/ClaimDataModal';
import { PrivacyModal } from '@/components/PrivacyModal';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { postChangelogVersionCheck } from '@/lib/client/api/user-state';
import { scheduleChangelogCheck } from '@/lib/client/changelog-check';
import { createCoalescedAsyncRunner, resolveNextOnboardingStep } from '@/lib/client/onboarding-flow';
import { useOnboardingState } from '@/hooks/useOnboardingState';
import { EMPTY_CLAIM_COUNTS, useClaimData } from '@/hooks/useClaimData';
import type { ClaimableCounts } from '@/types/client';

type OnboardingFlowContextValue = {
  changelogOpenSignal: number;
};

const OnboardingFlowContext = createContext<OnboardingFlowContextValue | null>(null);

export function OnboardingFlowProvider({ children }: { children: ReactNode }) {
  const { data: session, isPending: isSessionPending } = useAuthSession();
  const runtimeConfig = useRuntimeConfig();
  const user = session?.user as { id?: string; isAnonymous?: boolean } | undefined;
  const userId = user?.id ?? null;
  const isAnonymous = Boolean(user?.isAnonymous);
  const { query: claimCountsQuery } = useClaimData(Boolean(userId && !isAnonymous));
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
      const claimResult = await refetchClaimCounts();
      if (claimResult.isError) {
        console.error('Failed to check claimable data:', claimResult.error);
        return;
      }
      claimCounts = claimResult.data ?? EMPTY_CLAIM_COUNTS;
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

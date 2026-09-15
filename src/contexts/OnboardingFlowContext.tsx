'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ClaimDataModal from '@/components/auth/ClaimDataModal';
import { PrivacyModal } from '@/components/PrivacyModal';
import { ChangelogModal } from '@/components/settings/ChangelogModal';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { postChangelogVersionCheck } from '@/lib/client/api/user-state';
import { scheduleChangelogCheck } from '@/lib/client/changelog-check';
import { createCoalescedAsyncRunner, isPrivacyAcceptedForPolicy, resolveNextOnboardingStep } from '@/lib/client/onboarding-flow';
import { PRIVACY_POLICY_UPDATED_AT_MS } from '@/lib/shared/privacy-policy';
import { useOnboardingState } from '@/hooks/useOnboardingState';
import { EMPTY_CLAIM_COUNTS, useClaimData } from '@/hooks/useClaimData';
import type { ClaimableCounts } from '@/types/client';

type OnboardingFlowContextValue = {
  openChangelog: () => void;
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
  const [claimModalOwnerId, setClaimModalOwnerId] = useState<string | null>(null);
  const [claimableCounts, setClaimableCounts] = useState<ClaimableCounts>(EMPTY_CLAIM_COUNTS);
  const [isChangelogOpen, setIsChangelogOpen] = useState(false);

  const pendingChangelogOpenRef = useRef(false);
  const leavingBlockingModalRef = useRef<'privacy' | 'claim' | null>(null);
  const claimDismissedUsersRef = useRef<Set<string>>(new Set());
  const changelogVersionCheckKeyRef = useRef<string | null>(null);
  const changelogVersionCheckInFlightRef = useRef<string | null>(null);
  const currentUserIdRef = useRef(userId);

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
    if (onboardingData === undefined || leavingBlockingModalRef.current !== null) {
      return;
    }

    const privacyRequired = true;
    const privacyAccepted = !privacyRequired || isPrivacyAcceptedForPolicy(
      onboardingData.privacyAcceptedAtMs,
      PRIVACY_POLICY_UPDATED_AT_MS,
    );

    const isClaimEligible = Boolean(
      userId
      && !isAnonymous
      && !claimDismissedUsersRef.current.has(userId),
    );

    let claimCounts = EMPTY_CLAIM_COUNTS;
    let claimHasData = false;

    if (isClaimEligible) {
      const claimResult = await refetchClaimCounts();
      if (
        currentUserIdRef.current !== userId
        || leavingBlockingModalRef.current !== null
        || (userId !== null && claimDismissedUsersRef.current.has(userId))
      ) {
        return;
      }
      if (claimResult.isError) {
        console.error('Failed to check claimable data:', claimResult.error);
        return;
      }
      claimCounts = claimResult.data ?? EMPTY_CLAIM_COUNTS;
      const total = claimCounts.documents
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

    const nextBlockingModal = nextStep === 'privacy' || nextStep === 'claim'
      ? nextStep
      : null;
    // Blocking dialogs own focus and page inertness. Let the current dialog fully
    // leave before presenting the next step so two Headless UI dialogs never overlap.
    if (activeBlockingModal !== null && activeBlockingModal !== nextBlockingModal) {
      leavingBlockingModalRef.current = activeBlockingModal;
      setActiveBlockingModal(null);
      return;
    }

    if (nextStep === 'privacy') {
      setActiveBlockingModal('privacy');
      return;
    }

    if (nextStep === 'claim') {
      setClaimableCounts(claimCounts);
      setClaimModalOwnerId(userId);
      setActiveBlockingModal('claim');
      return;
    }

    if (nextStep === 'changelog') {
      pendingChangelogOpenRef.current = false;
      setIsChangelogOpen(true);
    }
  }, [activeBlockingModal, isAnonymous, onboardingQuery.data, refetchClaimCounts, userId]);

  useEffect(() => {
    const previousUserId = currentUserIdRef.current;
    currentUserIdRef.current = userId;
    if (
      previousUserId !== userId
      && activeBlockingModal === 'claim'
      && claimModalOwnerId !== userId
    ) {
      leavingBlockingModalRef.current = 'claim';
      setActiveBlockingModal(null);
    }
  }, [activeBlockingModal, claimModalOwnerId, userId]);

  useEffect(() => {
    runOnceFlowRef.current = runOnceFlow;
  }, [runOnceFlow]);

  const handleClaimComplete = useCallback(() => {
    if (claimModalOwnerId) {
      claimDismissedUsersRef.current.add(claimModalOwnerId);
    }
    leavingBlockingModalRef.current = 'claim';
    setActiveBlockingModal(null);
  }, [claimModalOwnerId]);

  const handlePrivacyAccepted = useCallback(() => {
    leavingBlockingModalRef.current = 'privacy';
    setActiveBlockingModal(null);
  }, []);

  const handleBlockingModalAfterLeave = useCallback((modal: 'privacy' | 'claim') => {
    if (leavingBlockingModalRef.current !== modal) return;
    leavingBlockingModalRef.current = null;
    void runFlow();
  }, [runFlow]);

  useEffect(() => {
    void runFlow();
  }, [isAnonymous, onboardingQuery.data, runFlow, userId]);

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
    openChangelog: () => setIsChangelogOpen(true),
  }), []);

  return (
    <OnboardingFlowContext.Provider value={contextValue}>
      {children}
      <PrivacyModal
        isOpen={activeBlockingModal === 'privacy'}
        onAccept={handlePrivacyAccepted}
        onDismiss={() => { }}
        onAfterLeave={() => handleBlockingModalAfterLeave('privacy')}
      />
      <ClaimDataModal
        isOpen={activeBlockingModal === 'claim' && claimModalOwnerId === userId}
        claimableCounts={claimableCounts}
        onDismiss={handleClaimComplete}
        onClaimed={handleClaimComplete}
        onAfterLeave={() => handleBlockingModalAfterLeave('claim')}
      />
      <ChangelogModal
        open={isChangelogOpen}
        onClose={() => setIsChangelogOpen(false)}
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

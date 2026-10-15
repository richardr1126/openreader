'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ClaimDataModal from '@/components/auth/ClaimDataModal';
import { PrivacyModal } from '@/components/PrivacyModal';
import { ChangelogModal } from '@/components/settings/ChangelogModal';
import { useLocalVoices } from '@/components/admin/useLocalVoices';
import { VoicesSetupModal } from '@/components/admin/VoicesSetupModal';
import { useSharedProviders } from '@/hooks/useSharedProviders';
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
  const { installProfile } = runtimeConfig;
  const router = useRouter();
  const user = session?.user as { id?: string; isAnonymous?: boolean; isAdmin?: boolean } | undefined;
  const userId = user?.id ?? null;
  const isAnonymous = Boolean(user?.isAnonymous);
  const { query: claimCountsQuery } = useClaimData(Boolean(userId && !isAnonymous));
  const refetchClaimCounts = claimCountsQuery.refetch;

  const { query: onboardingQuery } = useOnboardingState();

  // Desktop has no usable voice until Kokoro is downloaded or a voice service
  // is added. Derived from that state alone, so the step returns on the next
  // launch while it is still true (an interrupted download, say).
  const offerVoices = installProfile === 'desktop' && Boolean(user?.isAdmin);
  const voices = useLocalVoices({ enabled: offerVoices });
  const { providers: sharedProviders, isLoading: sharedProvidersLoading } = useSharedProviders();
  const voicesLoading = offerVoices && (voices.isPending || sharedProvidersLoading);
  const voicesNeeded = offerVoices && Boolean(voices.status) && !voices.error
    && !voices.installed && !voices.downloading && !voices.status?.downloading
    && !sharedProviders.some((provider) => provider.providerType !== 'kokoro-local');
  const voicesHandledRef = useRef(false);
  const [activeBlockingModal, setActiveBlockingModal] = useState<'privacy' | 'claim' | 'voices' | null>(null);
  const [claimModalOwnerId, setClaimModalOwnerId] = useState<string | null>(null);
  const [claimableCounts, setClaimableCounts] = useState<ClaimableCounts>(EMPTY_CLAIM_COUNTS);
  const [isChangelogOpen, setIsChangelogOpen] = useState(false);

  const pendingChangelogOpenRef = useRef(false);
  const leavingBlockingModalRef = useRef<'privacy' | 'claim' | 'voices' | null>(null);
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

    // The privacy notice describes a hosted instance and its operator. On desktop
    // the person using the app is its only owner and nothing leaves the machine.
    const privacyRequired = installProfile === 'server';
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

    // Decide the voices step only once its inputs have loaded, so it never
    // opens over the changelog.
    if (voicesLoading) return;

    const nextStep = resolveNextOnboardingStep({
      privacyRequired,
      privacyAccepted,
      claimEligible: isClaimEligible,
      claimHasData,
      // Once open, the step stays until the owner chooses, even as the
      // download it started changes what voicesNeeded reads.
      voicesPending: !voicesHandledRef.current && (activeBlockingModal === 'voices' || voicesNeeded),
      changelogPending: pendingChangelogOpenRef.current,
    });

    const nextBlockingModal = nextStep === 'privacy' || nextStep === 'claim' || nextStep === 'voices'
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

    if (nextStep === 'voices') {
      setActiveBlockingModal('voices');
      return;
    }

    if (nextStep === 'changelog') {
      pendingChangelogOpenRef.current = false;
      setIsChangelogOpen(true);
    }
  }, [activeBlockingModal, installProfile, isAnonymous, onboardingQuery.data, refetchClaimCounts, userId, voicesLoading, voicesNeeded]);

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

  const handleVoicesChosen = useCallback((useService: boolean) => {
    voicesHandledRef.current = true;
    leavingBlockingModalRef.current = 'voices';
    setActiveBlockingModal(null);
    if (useService) router.push('/app/settings?section=providers');
  }, [router]);

  const handleBlockingModalAfterLeave = useCallback((modal: 'privacy' | 'claim' | 'voices') => {
    if (leavingBlockingModalRef.current !== modal) return;
    leavingBlockingModalRef.current = null;
    void runFlow();
  }, [runFlow]);

  useEffect(() => {
    void runFlow();
  }, [isAnonymous, onboardingQuery.data, runFlow, userId, voicesLoading, voicesNeeded]);

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
      <VoicesSetupModal
        isOpen={activeBlockingModal === 'voices'}
        voices={voices}
        onContinue={() => handleVoicesChosen(false)}
        onUseService={() => handleVoicesChosen(true)}
        onAfterLeave={() => handleBlockingModalAfterLeave('voices')}
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

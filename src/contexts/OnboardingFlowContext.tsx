'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ClaimDataModal, { type ClaimableCounts } from '@/components/auth/ClaimDataModal';
import { DexieMigrationModal } from '@/components/documents/DexieMigrationModal';
import { PrivacyModal } from '@/components/PrivacyModal';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { getAllEpubDocuments, getAllHtmlDocuments, getAllPdfDocuments, getAppConfig, setFirstVisit } from '@/lib/client/dexie';
import { listDocuments } from '@/lib/client/api/documents';
import { postChangelogVersionCheck } from '@/lib/client/api/user-state';
import { scheduleChangelogCheck } from '@/lib/client/changelog-check';
import { createCoalescedAsyncRunner, resolveNextOnboardingStep } from '@/lib/client/onboarding-flow';
import { ONBOARDING_STATE_REGISTRY } from '@/lib/shared/onboarding-state';

type OnboardingFlowContextValue = {
  changelogOpenSignal: number;
};

const OnboardingFlowContext = createContext<OnboardingFlowContextValue | null>(null);

type MigrationPromptState = {
  shouldPrompt: boolean;
  localCount: number;
  missingCount: number;
};

const EMPTY_CLAIM_COUNTS: ClaimableCounts = {
  documents: 0,
  audiobooks: 0,
  preferences: 0,
  progress: 0,
};

function toClaimableCounts(value: unknown): ClaimableCounts {
  const rec = (value && typeof value === 'object') ? (value as Record<string, unknown>) : {};
  return {
    documents: Number(rec.documents ?? 0),
    audiobooks: Number(rec.audiobooks ?? 0),
    preferences: Number(rec.preferences ?? 0),
    progress: Number(rec.progress ?? 0),
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

async function getMigrationPromptState(privacyGateSatisfied: boolean): Promise<MigrationPromptState> {
  const cfg = await getAppConfig();
  if (!privacyGateSatisfied || cfg?.documentsMigrationPrompted) {
    return { shouldPrompt: false, localCount: 0, missingCount: 0 };
  }

  const [pdfs, epubs, htmls] = await Promise.all([
    getAllPdfDocuments(),
    getAllEpubDocuments(),
    getAllHtmlDocuments(),
  ]);
  const localDocs = [
    ...pdfs.map((d) => d.id),
    ...epubs.map((d) => d.id),
    ...htmls.map((d) => d.id),
  ];
  const localCount = localDocs.length;
  if (localCount === 0) {
    return { shouldPrompt: false, localCount: 0, missingCount: 0 };
  }

  const serverDocs = await listDocuments().catch(() => null);
  if (!serverDocs) {
    return { shouldPrompt: true, localCount, missingCount: localCount };
  }

  const serverIds = new Set(serverDocs.map((d) => d.id));
  const missingCount = localDocs.filter((id) => !serverIds.has(id)).length;
  return {
    shouldPrompt: missingCount > 0,
    localCount,
    missingCount,
  };
}

type LocalOnboardingSnapshot = {
  privacyAccepted: boolean;
  firstVisitSettingsOpened: boolean;
};

async function readLocalOnboardingSnapshot(): Promise<LocalOnboardingSnapshot> {
  const appConfig = await getAppConfig();
  const row = appConfig as Record<string, unknown> | null;
  const privacyKey = ONBOARDING_STATE_REGISTRY.privacyAccepted.localKey;
  const firstVisitKey = ONBOARDING_STATE_REGISTRY.firstVisitSettingsOpened.localKey;

  return {
    privacyAccepted: privacyKey ? Boolean(row?.[privacyKey]) : false,
    firstVisitSettingsOpened: firstVisitKey ? Boolean(row?.[firstVisitKey]) : false,
  };
}

export function OnboardingFlowProvider({ children }: { children: ReactNode }) {
  const { data: session, isPending: isSessionPending } = useAuthSession();
  const runtimeConfig = useRuntimeConfig();
  const user = session?.user as { id?: string; isAnonymous?: boolean } | undefined;
  const userId = user?.id ?? null;
  const isAnonymous = Boolean(user?.isAnonymous);

  const [activeBlockingModal, setActiveBlockingModal] = useState<'privacy' | 'claim' | 'migration' | null>(null);
  const [claimableCounts, setClaimableCounts] = useState<ClaimableCounts>(EMPTY_CLAIM_COUNTS);
  const [migrationCounts, setMigrationCounts] = useState<{ localCount: number; missingCount: number }>({
    localCount: 0,
    missingCount: 0,
  });
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
    const local = await readLocalOnboardingSnapshot();
    const privacyRequired = true;
    const privacyAccepted = !privacyRequired || local.privacyAccepted;

    const isClaimEligible = Boolean(
      userId
      && !isAnonymous
      && !claimDismissedUsersRef.current.has(userId),
    );

    let claimCounts = EMPTY_CLAIM_COUNTS;
    let claimHasData = false;

    if (isClaimEligible) {
      claimCounts = await fetchClaimableCounts();
      const total = claimCounts.documents + claimCounts.audiobooks + claimCounts.preferences + claimCounts.progress;
      claimHasData = total > 0;
      if (!claimHasData && userId) {
        claimDismissedUsersRef.current.add(userId);
      }
    }

    const migrationState = await getMigrationPromptState(privacyAccepted);

    const nextStep = resolveNextOnboardingStep({
      privacyRequired,
      privacyAccepted,
      claimEligible: isClaimEligible,
      claimHasData,
      migrationRequired: migrationState.shouldPrompt,
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

    if (nextStep === 'migration') {
      setMigrationCounts({
        localCount: migrationState.localCount,
        missingCount: migrationState.missingCount,
      });
      setActiveBlockingModal('migration');
      return;
    }

    setActiveBlockingModal(null);

    if (!local.firstVisitSettingsOpened) {
      await setFirstVisit(true);
    }

    if (nextStep === 'changelog') {
      pendingChangelogOpenRef.current = false;
      setChangelogOpenSignal((value) => value + 1);
    }
  }, [isAnonymous, userId]);

  runOnceFlowRef.current = runOnceFlow;

  const handleClaimComplete = useCallback(() => {
    if (userId) {
      claimDismissedUsersRef.current.add(userId);
    }
    setActiveBlockingModal(null);
    void runFlow();
  }, [runFlow, userId]);

  const handleMigrationComplete = useCallback(() => {
    setActiveBlockingModal(null);
    void runFlow();
  }, [runFlow]);

  const handlePrivacyAccepted = useCallback(() => {
    setActiveBlockingModal(null);
    void runFlow();
  }, [runFlow]);

  useEffect(() => {
    void runFlow();
  }, [isAnonymous, runFlow, userId]);

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
      <DexieMigrationModal
        isOpen={activeBlockingModal === 'migration'}
        localCount={migrationCounts.localCount}
        missingCount={migrationCounts.missingCount}
        onComplete={handleMigrationComplete}
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

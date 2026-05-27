'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ClaimDataModal, { type ClaimableCounts } from '@/components/auth/ClaimDataModal';
import { DexieMigrationModal } from '@/components/documents/DexieMigrationModal';
import { PrivacyModal } from '@/components/PrivacyModal';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { getAllEpubDocuments, getAllHtmlDocuments, getAllPdfDocuments, getAppConfig, setFirstVisit } from '@/lib/client/dexie';
import { listDocuments } from '@/lib/client/api/documents';
import { postChangelogVersionCheck } from '@/lib/client/api/user-state';
import { scheduleChangelogCheck } from '@/lib/client/changelog-check';
import { ONBOARDING_STATE_REGISTRY } from '@/lib/shared/onboarding-state';

type SettingsOpenOptions = {
  changelog?: boolean;
};

type SettingsController = {
  open: (options?: SettingsOpenOptions) => void;
  close: () => void;
};

type OnboardingFlowContextValue = {
  requestOpenSettings: (options?: SettingsOpenOptions) => Promise<boolean>;
  registerSettingsController: (controller: SettingsController | null) => void;
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

async function getMigrationPromptState(): Promise<MigrationPromptState> {
  const cfg = await getAppConfig();
  if (!cfg?.privacyAccepted || cfg.documentsMigrationPrompted) {
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
  const { authEnabled } = useAuthConfig();
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

  const settingsControllerRef = useRef<SettingsController | null>(null);
  const pendingChangelogOpenRef = useRef(false);
  const runningAdvanceRef = useRef(false);
  const claimDismissedUsersRef = useRef<Set<string>>(new Set());
  const changelogVersionCheckKeyRef = useRef<string | null>(null);
  const changelogVersionCheckInFlightRef = useRef<string | null>(null);

  const openSettingsNow = useCallback((options?: SettingsOpenOptions) => {
    settingsControllerRef.current?.open(options);
  }, []);

  const advanceFlow = useCallback(async () => {
    if (runningAdvanceRef.current) {
      return;
    }
    runningAdvanceRef.current = true;
    try {
      const local = await readLocalOnboardingSnapshot();
      if (authEnabled && !local.privacyAccepted) {
        setActiveBlockingModal('privacy');
        return;
      }
      if (activeBlockingModal === 'privacy') {
        setActiveBlockingModal(null);
      } else if (activeBlockingModal) {
        return;
      }

      if (authEnabled && userId && !isAnonymous && !claimDismissedUsersRef.current.has(userId)) {
        const counts = await fetchClaimableCounts();
        const total = counts.documents + counts.audiobooks + counts.preferences + counts.progress;
        if (total > 0) {
          setClaimableCounts(counts);
          setActiveBlockingModal('claim');
          return;
        }
        claimDismissedUsersRef.current.add(userId);
      }

      const migrationState = await getMigrationPromptState();
      if (migrationState.shouldPrompt) {
        setMigrationCounts({
          localCount: migrationState.localCount,
          missingCount: migrationState.missingCount,
        });
        setActiveBlockingModal('migration');
        return;
      }

      if (!local.firstVisitSettingsOpened) {
        await setFirstVisit(true);
        openSettingsNow();
        return;
      }

      if (pendingChangelogOpenRef.current) {
        pendingChangelogOpenRef.current = false;
        openSettingsNow({ changelog: true });
      }
    } finally {
      runningAdvanceRef.current = false;
    }
  }, [activeBlockingModal, authEnabled, isAnonymous, openSettingsNow, userId]);

  const requestOpenSettings = useCallback(async (options?: SettingsOpenOptions): Promise<boolean> => {
    const local = await readLocalOnboardingSnapshot();
    if (authEnabled && !local.privacyAccepted) {
      if (options?.changelog) {
        pendingChangelogOpenRef.current = true;
      }
      settingsControllerRef.current?.close();
      return false;
    }

    if (activeBlockingModal) {
      if (options?.changelog) {
        pendingChangelogOpenRef.current = true;
      }
      return false;
    }

    if (!settingsControllerRef.current) {
      if (options?.changelog) {
        pendingChangelogOpenRef.current = true;
      }
      return false;
    }

    settingsControllerRef.current.open(options);
    return true;
  }, [activeBlockingModal, authEnabled]);

  const registerSettingsController = useCallback((controller: SettingsController | null) => {
    settingsControllerRef.current = controller;
    if (controller) {
      void advanceFlow();
    }
  }, [advanceFlow]);

  const handleClaimComplete = useCallback(() => {
    if (userId) {
      claimDismissedUsersRef.current.add(userId);
    }
    setActiveBlockingModal(null);
    void advanceFlow();
  }, [advanceFlow, userId]);

  const handleMigrationComplete = useCallback(() => {
    setActiveBlockingModal(null);
    void advanceFlow();
  }, [advanceFlow]);

  const handlePrivacyAccepted = useCallback(() => {
    setActiveBlockingModal(null);
    void advanceFlow();
  }, [advanceFlow]);

  useEffect(() => {
    void advanceFlow();
  }, [advanceFlow, authEnabled, isAnonymous, userId]);

  useEffect(() => {
    if (!authEnabled) {
      return;
    }
    const onPrivacyAccepted = () => {
      void advanceFlow();
    };
    window.addEventListener('openreader:privacyAccepted', onPrivacyAccepted);
    return () => {
      window.removeEventListener('openreader:privacyAccepted', onPrivacyAccepted);
    };
  }, [advanceFlow, authEnabled]);

  useEffect(() => {
    return scheduleChangelogCheck({
      authEnabled,
      isSessionPending,
      sessionUserId: userId,
      appVersion: runtimeConfig.appVersion,
      completedRef: changelogVersionCheckKeyRef,
      inFlightRef: changelogVersionCheckInFlightRef,
      postCheck: async (currentVersion) => postChangelogVersionCheck(currentVersion),
      onShouldOpen: () => {
        pendingChangelogOpenRef.current = true;
        void advanceFlow();
      },
      delayMs: 120,
      retryDelayMs: 400,
    });
  }, [advanceFlow, authEnabled, isSessionPending, runtimeConfig.appVersion, userId]);

  const contextValue = useMemo<OnboardingFlowContextValue>(() => ({
    requestOpenSettings,
    registerSettingsController,
  }), [registerSettingsController, requestOpenSettings]);

  return (
    <OnboardingFlowContext.Provider value={contextValue}>
      {children}
      {authEnabled && (
        <PrivacyModal
          isOpen={activeBlockingModal === 'privacy'}
          onAccept={handlePrivacyAccepted}
          onDismiss={() => { }}
        />
      )}
      {authEnabled && (
        <ClaimDataModal
          isOpen={activeBlockingModal === 'claim'}
          claimableCounts={claimableCounts}
          onDismiss={handleClaimComplete}
          onClaimed={handleClaimComplete}
        />
      )}
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

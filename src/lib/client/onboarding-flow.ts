export type OnboardingStep = 'privacy' | 'claim' | 'voices' | 'changelog' | 'done';

export type OnboardingStepSnapshot = {
  privacyRequired: boolean;
  privacyAccepted: boolean;
  claimEligible: boolean;
  claimHasData: boolean;
  /** Desktop with no usable voice yet: Kokoro not downloaded and no voice service. */
  voicesPending: boolean;
  changelogPending: boolean;
};

export function isPrivacyAcceptedForPolicy(
  privacyAcceptedAtMs: number | null | undefined,
  policyUpdatedAtMs: number,
): boolean {
  return typeof privacyAcceptedAtMs === 'number'
    && Number.isFinite(privacyAcceptedAtMs)
    && privacyAcceptedAtMs > policyUpdatedAtMs;
}

export function resolveNextOnboardingStep(snapshot: OnboardingStepSnapshot): OnboardingStep {
  if (snapshot.privacyRequired && !snapshot.privacyAccepted) {
    return 'privacy';
  }

  if (snapshot.claimEligible && snapshot.claimHasData) {
    return 'claim';
  }

  if (snapshot.voicesPending) {
    return 'voices';
  }

  if (snapshot.changelogPending) {
    return 'changelog';
  }

  return 'done';
}

export function createCoalescedAsyncRunner(runOnce: () => Promise<void>): () => Promise<void> {
  let running = false;
  let rerunRequested = false;

  return async () => {
    if (running) {
      rerunRequested = true;
      return;
    }

    running = true;
    try {
      do {
        rerunRequested = false;
        await runOnce();
      } while (rerunRequested);
    } finally {
      running = false;
    }
  };
}

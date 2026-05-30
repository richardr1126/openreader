export type OnboardingStep = 'privacy' | 'claim' | 'migration' | 'changelog' | 'done';

export type OnboardingStepSnapshot = {
  privacyRequired: boolean;
  privacyAccepted: boolean;
  claimEligible: boolean;
  claimHasData: boolean;
  migrationRequired: boolean;
  changelogPending: boolean;
};

export function resolveNextOnboardingStep(snapshot: OnboardingStepSnapshot): OnboardingStep {
  if (snapshot.privacyRequired && !snapshot.privacyAccepted) {
    return 'privacy';
  }

  if (snapshot.claimEligible && snapshot.claimHasData) {
    return 'claim';
  }

  if (snapshot.migrationRequired) {
    return 'migration';
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

import { describe, expect, test } from 'vitest';

import { createCoalescedAsyncRunner, resolveNextOnboardingStep } from '../../src/lib/client/onboarding-flow';

describe('onboarding flow resolver', () => {
  test('resolves deterministic order with privacy first', () => {
    const step = resolveNextOnboardingStep({
      privacyRequired: true,
      privacyAccepted: false,
      claimEligible: true,
      claimHasData: true,
      migrationRequired: true,
      changelogPending: true,
    });

    expect(step).toBe('privacy');
  });

  test('resolves claim after privacy is accepted', () => {
    const step = resolveNextOnboardingStep({
      privacyRequired: true,
      privacyAccepted: true,
      claimEligible: true,
      claimHasData: true,
      migrationRequired: true,
      changelogPending: true,
    });

    expect(step).toBe('claim');
  });

  test('resolves migration when no claim is needed', () => {
    const step = resolveNextOnboardingStep({
      privacyRequired: true,
      privacyAccepted: true,
      claimEligible: true,
      claimHasData: false,
      migrationRequired: true,
      changelogPending: true,
    });

    expect(step).toBe('migration');
  });

  test('resolves changelog when prior steps are clear', () => {
    const step = resolveNextOnboardingStep({
      privacyRequired: true,
      privacyAccepted: true,
      claimEligible: true,
      claimHasData: false,
      migrationRequired: false,
      changelogPending: true,
    });

    expect(step).toBe('changelog');
  });

  test('resolves done when no steps are pending', () => {
    const authStep = resolveNextOnboardingStep({
      privacyRequired: true,
      privacyAccepted: true,
      claimEligible: true,
      claimHasData: false,
      migrationRequired: false,
      changelogPending: false,
    });
    const minimalStep = resolveNextOnboardingStep({
      privacyRequired: false,
      privacyAccepted: false,
      claimEligible: false,
      claimHasData: false,
      migrationRequired: false,
      changelogPending: false,
    });

    expect(authStep).toBe('done');
    expect(minimalStep).toBe('done');
  });
});

describe('coalesced onboarding runner', () => {
  test('coalesces concurrent triggers into one extra rerun', async () => {
    let runs = 0;
    let nestedRequested = false;

    const run = createCoalescedAsyncRunner(async () => {
      runs += 1;
      if (!nestedRequested) {
        nestedRequested = true;
        await run();
      }
    });

    await run();
    expect(runs).toBe(2);
  });

  test('does not rerun when no trigger arrives during execution', async () => {
    let runs = 0;
    const run = createCoalescedAsyncRunner(async () => {
      runs += 1;
    });

    await run();
    expect(runs).toBe(1);
  });
});

import { describe, expect, test } from 'vitest';
import { ONBOARDING_STATE_REGISTRY } from '../../src/lib/shared/onboarding-state';
import { SYNCED_PREFERENCE_KEYS } from '../../src/types/user-state';

describe('onboarding state storage scopes', () => {
  test('keeps local onboarding flags out of synced server preferences', () => {
    expect(ONBOARDING_STATE_REGISTRY.privacyAccepted.scope).toBe('local-dexie');
    expect(ONBOARDING_STATE_REGISTRY.firstVisitSettingsOpened.scope).toBe('local-dexie');
    expect(ONBOARDING_STATE_REGISTRY.documentsMigrationPrompted.scope).toBe('local-dexie');
    expect(ONBOARDING_STATE_REGISTRY.changelogLastSeenAppVersion.scope).toBe('server-user-preferences');

    const synced = new Set<string>(SYNCED_PREFERENCE_KEYS);

    expect(synced.has(ONBOARDING_STATE_REGISTRY.privacyAccepted.localKey!)).toBe(false);
    expect(synced.has(ONBOARDING_STATE_REGISTRY.firstVisitSettingsOpened.localKey!)).toBe(false);
    expect(synced.has(ONBOARDING_STATE_REGISTRY.documentsMigrationPrompted.localKey!)).toBe(false);
  });
});


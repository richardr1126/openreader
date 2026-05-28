export type OnboardingStorageScope = 'local-dexie' | 'server-user-preferences' | 'hybrid';

export type OnboardingStateDescriptor = {
  /**
   * Where this state is persisted today.
   * - local-dexie: browser/device-local only
   * - server-user-preferences: per-user on server
   * - hybrid: intentionally persisted in both places
   */
  scope: OnboardingStorageScope;
  /**
   * Optional local key name when state is stored in Dexie app-config.
   */
  localKey?: string;
  /**
   * Optional server-side key when state is stored in user preferences/meta.
   */
  serverKey?: string;
};

/**
 * Central registry for onboarding-related state and where each item lives.
 * Keep this map up to date whenever onboarding persistence changes.
 */
export const ONBOARDING_STATE_REGISTRY = {
  privacyAccepted: {
    scope: 'local-dexie',
    localKey: 'privacyAccepted',
  },
  firstVisitSettingsOpened: {
    scope: 'local-dexie',
    localKey: 'firstVisit',
  },
  documentsMigrationPrompted: {
    scope: 'local-dexie',
    localKey: 'documentsMigrationPrompted',
  },
  changelogLastSeenAppVersion: {
    scope: 'server-user-preferences',
    serverKey: '_meta.lastSeenAppVersion',
  },
} as const satisfies Record<string, OnboardingStateDescriptor>;

export type OnboardingStateKey = keyof typeof ONBOARDING_STATE_REGISTRY;


'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, initDB, migrateLegacyDexieDocumentIdsToSha, updateAppConfig } from '@/lib/client/dexie';
import { APP_CONFIG_DEFAULTS, type ViewType, type SavedVoices, type AppConfigValues, type AppConfigRow } from '@/types/config';
import { isBuiltInTtsProviderId } from '@/lib/shared/tts-provider-catalog';
import { resolveProviderDefaults } from '@/lib/shared/tts-provider-policy';
import { scheduleUserPreferencesSync, cancelPendingPreferenceSync, getUserPreferences, putUserPreferences } from '@/lib/client/api/user-state';
import { SYNCED_PREFERENCE_KEYS, type SyncedPreferenceKey, type SyncedPreferencesPatch } from '@/types/user-state';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useFeatureFlag, useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { buildSyncedPreferencePatch } from '@/lib/client/config/preferences';
import { applyConfigUpdate } from '@/lib/client/config/updates';
import { useSharedProviders } from '@/hooks/useSharedProviders';
import toast from 'react-hot-toast';
export type { ViewType } from '@/types/config';

/** Configuration values for the application */

/** Interface defining the configuration context shape and functionality */
interface ConfigContextType {
  apiKey: string;
  baseUrl: string;
  viewType: ViewType;
  voiceSpeed: number;
  audioPlayerSpeed: number;
  voice: string;
  skipBlank: boolean;
  epubTheme: boolean;
  segmentPreloadDepthPages: number;
  segmentPreloadSentenceLookahead: number;
  ttsSegmentMaxBlockLength: number;
  headerMargin: number;
  footerMargin: number;
  leftMargin: number;
  rightMargin: number;
  providerRef: string;
  providerType: AppConfigValues['providerType'];
  ttsModel: string;
  ttsInstructions: string;
  savedVoices: SavedVoices;
  updateConfig: (newConfig: Partial<{ apiKey: string; baseUrl: string; viewType: ViewType }>) => Promise<void>;
  updateConfigKey: <K extends keyof AppConfigValues>(key: K, value: AppConfigValues[K]) => Promise<void>;
  isLoading: boolean;
  isDBReady: boolean;
  pdfHighlightEnabled: boolean;
  pdfWordHighlightEnabled: boolean;
  epubHighlightEnabled: boolean;
  epubWordHighlightEnabled: boolean;
  htmlHighlightEnabled: boolean;
  htmlWordHighlightEnabled: boolean;
}

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

/**
 * Provider component for application configuration
 * Manages global configuration state and persistence
 * @param {Object} props - Component props
 * @param {ReactNode} props.children - Child components to be wrapped by the provider
 */
export function ConfigProvider({ children }: { children: ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [isDBReady, setIsDBReady] = useState(false);
  const ttsProvidersTabDisabled = !useFeatureFlag('enableTtsProvidersTab');
  const restrictUserApiKeys = useFeatureFlag('restrictUserApiKeys');
  const showAllProviderModels = useFeatureFlag('showAllProviderModels');
  const didRunStartupMigrations = useRef(false);
  const didAttemptInitialPreferenceSeedForSession = useRef<string | null>(null);
  const syncedPreferenceKeys = useMemo(() => new Set<string>(SYNCED_PREFERENCE_KEYS), []);
  const { providers: sharedProviders, isLoading: sharedProvidersLoading } = useSharedProviders();
  const { data: sessionData, isPending: isSessionPending } = useAuthSession();
  const sessionKey = sessionData?.user?.id ?? 'no-session';
  // The instance/admin default provider. An empty user providerRef "inherits"
  // this, resolved (admin slug -> concrete provider) where the value is used.
  const adminDefaultProviderRef = useRuntimeConfig().defaultTtsProvider;

  const queueSyncedPreferencePatch = useCallback((patch: Partial<AppConfigValues>) => {
    if (sessionKey === 'no-session') return;

    const syncedPatch: SyncedPreferencesPatch = {};
    for (const key of SYNCED_PREFERENCE_KEYS) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (value === undefined) continue;
      (syncedPatch as Record<SyncedPreferenceKey, unknown>)[key] = value;
    }
    if (Object.keys(syncedPatch).length === 0) return;
    scheduleUserPreferencesSync(syncedPatch, sessionKey);
  }, [sessionKey]);

  // Cancel pending/in-flight preference syncs whenever the session changes or on unmount.
  useEffect(() => {
    return () => {
      cancelPendingPreferenceSync();
    };
  }, [sessionKey]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ status?: string; ms?: number }>).detail;
      const status = detail?.status;
      if (status === 'opened') {
        toast.dismiss('dexie-blocked');
        return;
      }
      if (status === 'blocked' || status === 'stalled') {
        const message =
          'Database upgrade is waiting for another OpenReader tab. Close other OpenReader tabs and reload.';
        toast.error(message, { id: 'dexie-blocked', duration: Infinity });
      }
    };

    window.addEventListener('openreader:dexie', handler as EventListener);
    return () => {
      window.removeEventListener('openreader:dexie', handler as EventListener);
    };
  }, []);

  useEffect(() => {
    const initializeDB = async () => {
      try {
        setIsLoading(true);
        await initDB();
        setIsDBReady(true);
      } catch (error) {
        console.error('Error initializing Dexie:', error);
      } finally {
        setIsLoading(false);
      }
    };

    initializeDB();
  }, []);

  useEffect(() => {
    if (!isDBReady) return;
    if (didRunStartupMigrations.current) return;
    didRunStartupMigrations.current = true;

    const run = async () => {
      try {
        await migrateLegacyDexieDocumentIdsToSha();
      } catch (error) {
        console.warn('Startup migrations failed:', error);
      }
    };

    void run();
  }, [isDBReady]);

  const refreshSyncedPreferencesFromServer = useCallback(async (signal?: AbortSignal) => {
    if (!isDBReady) return;
    try {
      const remote = await getUserPreferences({ signal });
      if (!remote?.hasStoredPreferences) return;
      if (!remote.preferences || Object.keys(remote.preferences).length === 0) return;
      await updateAppConfig(remote.preferences as Partial<AppConfigRow>);
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
      console.warn('Failed to load synced preferences:', error);
    }
  }, [isDBReady]);

  useEffect(() => {
    if (!isDBReady || isSessionPending) return;
    const controller = new AbortController();
    refreshSyncedPreferencesFromServer(controller.signal).catch((error) => {
      if ((error as Error)?.name === 'AbortError') return;
      console.warn('Synced preferences refresh failed:', error);
    });
    return () => controller.abort();
  }, [isDBReady, isSessionPending, sessionKey, refreshSyncedPreferencesFromServer]);

  useEffect(() => {
    if (!isDBReady) return;
    let activeController: AbortController | null = null;
    const onFocus = () => {
      if (activeController) activeController.abort();
      activeController = new AbortController();
      refreshSyncedPreferencesFromServer(activeController.signal).catch((error) => {
        if ((error as Error)?.name === 'AbortError') return;
        console.warn('Focus synced preferences refresh failed:', error);
      });
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (activeController) activeController.abort();
    };
  }, [isDBReady, refreshSyncedPreferencesFromServer]);

  const appConfig = useLiveQuery(
    async () => {
      if (!isDBReady) return null;
      const row = await db['app-config'].get('singleton');
      return row ?? null;
    },
    [isDBReady],
    null,
  );

  const config: AppConfigValues | null = useMemo(() => {
    if (!appConfig) return null;
    const { id, ...rest } = appConfig;
    void id;
    return { ...APP_CONFIG_DEFAULTS, ...rest };
  }, [appConfig]);

  useEffect(() => {
    if (ttsProvidersTabDisabled && isDBReady && appConfig && !sharedProvidersLoading) {
      const resetPatch: Partial<AppConfigRow> = {};

      // When the provider tab is hidden, clear any user-set provider config back to
      // "inherit the admin default" (empty) rather than baking in a concrete value.
      if (appConfig.apiKey !== '') resetPatch.apiKey = '';
      if (appConfig.baseUrl !== '') resetPatch.baseUrl = '';
      if (appConfig.providerRef !== '') resetPatch.providerRef = '';
      if (appConfig.providerType !== 'unknown') resetPatch.providerType = 'unknown';
      if (appConfig.ttsModel !== '') resetPatch.ttsModel = '';
      if (appConfig.ttsInstructions !== '') resetPatch.ttsInstructions = '';
      // Keep voice selection state intact so player/Audiobook voice pickers still
      // work when the TTS providers tab is hidden. This reset is only for provider
      // configuration fields.

      if (Object.keys(resetPatch).length === 0) return;

      updateAppConfig(resetPatch).catch((error) => {
        console.warn('Failed to clear hidden TTS provider settings:', error);
      });
      queueSyncedPreferencePatch(resetPatch);
    }
  }, [ttsProvidersTabDisabled, isDBReady, appConfig, queueSyncedPreferencePatch, sharedProvidersLoading]);

  useEffect(() => {
    if (restrictUserApiKeys && isDBReady && appConfig && !sharedProvidersLoading) {
      const resetPatch: Partial<AppConfigRow> = {};

      if (appConfig.apiKey !== '') resetPatch.apiKey = '';
      if (appConfig.baseUrl !== '') resetPatch.baseUrl = '';
      // Built-in providers aren't selectable in restricted mode. Clear any stale
      // built-in selection (including the old 'custom-openai' default that used to
      // be baked into every config) back to "inherit the admin default" so the
      // user follows whatever shared provider the admin has configured.
      if (isBuiltInTtsProviderId(appConfig.providerRef)) {
        resetPatch.providerRef = '';
        resetPatch.providerType = 'unknown';
        resetPatch.ttsModel = '';
        resetPatch.ttsInstructions = '';
      }

      if (Object.keys(resetPatch).length === 0) return;

      updateAppConfig(resetPatch).catch((error) => {
        console.warn('Failed to enforce restricted user API key mode:', error);
      });
      queueSyncedPreferencePatch(resetPatch);
    }
  }, [restrictUserApiKeys, isDBReady, appConfig, queueSyncedPreferencePatch, sharedProvidersLoading]);

  useEffect(() => {
    if (showAllProviderModels || !isDBReady || !appConfig || sharedProvidersLoading) return;
    // Inheriting (empty providerRef): the effective model is resolved at read
    // time, so there is nothing to persist/enforce here.
    if (!appConfig.providerRef) return;
    const providerDefaults = resolveProviderDefaults({
      providerRef: appConfig.providerRef,
      providerType: appConfig.providerType,
      sharedProviders,
      fallbackProviderRef: adminDefaultProviderRef,
    });
    if (!providerDefaults.defaultModel) return;
    if (appConfig.ttsModel === providerDefaults.defaultModel) return;
    const patch: Partial<AppConfigRow> = { ttsModel: providerDefaults.defaultModel };
    updateAppConfig(patch).catch((error) => {
      console.warn('Failed to enforce provider default model restriction:', error);
    });
    queueSyncedPreferencePatch(patch);
  }, [showAllProviderModels, isDBReady, appConfig, sharedProviders, adminDefaultProviderRef, queueSyncedPreferencePatch, sharedProvidersLoading]);

  useEffect(() => {
    if (!isDBReady || !appConfig || isSessionPending) return;
    if (didAttemptInitialPreferenceSeedForSession.current === sessionKey) return;
    didAttemptInitialPreferenceSeedForSession.current = sessionKey;

    const controller = new AbortController();

    const run = async () => {
      try {
        const remote = await getUserPreferences({ signal: controller.signal });
        if (remote?.hasStoredPreferences) return;

        // Seed only user-customized (non-default) values. This prevents fresh/default
        // profiles from overwriting existing server values during first-run races.
        const patch = buildSyncedPreferencePatch(appConfig, { nonDefaultOnly: true });
        if (Object.keys(patch).length === 0) return;

        await putUserPreferences(patch, { clientUpdatedAtMs: Date.now(), signal: controller.signal });
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') return;
        console.warn('Failed to seed initial synced preferences from local Dexie:', error);
      }
    };

    run().catch((error) => {
      if ((error as Error)?.name === 'AbortError') return;
      console.warn('Initial synced preferences seed failed:', error);
    });

    return () => controller.abort();
  }, [isDBReady, appConfig, isSessionPending, sessionKey]);

  // Destructure for convenience and to match context shape
  const {
    apiKey,
    baseUrl,
    viewType,
    voiceSpeed,
    audioPlayerSpeed,
    voice,
    skipBlank,
    epubTheme,
    headerMargin,
    footerMargin,
    leftMargin,
    rightMargin,
    providerRef,
    providerType: _persistedProviderType,
    ttsModel,
    ttsInstructions,
    savedVoices,
    segmentPreloadDepthPages,
    segmentPreloadSentenceLookahead,
    ttsSegmentMaxBlockLength,
    pdfHighlightEnabled,
    pdfWordHighlightEnabled,
    epubHighlightEnabled,
    epubWordHighlightEnabled,
    htmlHighlightEnabled,
    htmlWordHighlightEnabled,
  } = config || APP_CONFIG_DEFAULTS;
  // Resolve the effective provider for consumers. An empty stored providerRef
  // means "inherit the admin default", which we resolve here so the reader,
  // voice pickers, and settings UI all see a concrete, usable provider without
  // mutating the stored ("inherit") value.
  const effectiveProvider = useMemo(
    () => resolveProviderDefaults({
      providerRef,
      providerType: _persistedProviderType,
      sharedProviders,
      fallbackProviderRef: adminDefaultProviderRef,
    }),
    [providerRef, _persistedProviderType, sharedProviders, adminDefaultProviderRef],
  );
  const effectiveProviderRef = effectiveProvider.providerRef;
  const providerType = effectiveProvider.providerType;
  const effectiveTtsModel = ttsModel || effectiveProvider.defaultModel;
  const effectiveTtsInstructions = ttsInstructions || effectiveProvider.defaultInstructions;

  useEffect(() => {
    if (!isDBReady || !appConfig || sharedProvidersLoading) return;
    // Only persist a resolved providerType for an explicitly chosen provider.
    // While inheriting (empty providerRef) the type stays unset in storage.
    if (!appConfig.providerRef) return;
    if (appConfig.providerType === providerType) return;
    const patch: Partial<AppConfigRow> = { providerType };
    updateAppConfig(patch).catch((error) => {
      console.warn('Failed to persist resolved providerType:', error);
    });
    queueSyncedPreferencePatch(patch);
  }, [isDBReady, appConfig, providerType, queueSyncedPreferencePatch, sharedProvidersLoading]);
  void _persistedProviderType;

  useEffect(() => {
    if (!isDBReady || !appConfig || sharedProvidersLoading) return;
    // Inheriting (empty providerRef): the effective model is resolved at read
    // time; don't write a concrete model into the "inherit" state.
    if (!appConfig.providerRef) return;
    const providerDefaults = resolveProviderDefaults({
      providerRef: appConfig.providerRef,
      providerType: appConfig.providerType,
      sharedProviders,
      fallbackProviderRef: adminDefaultProviderRef,
    });
    if (!providerDefaults.defaultModel) return;
    if (appConfig.ttsModel === providerDefaults.defaultModel) return;
    // Heal stale fallback model values that were written while the provider UI
    // was disabled and shared provider context was unavailable.
    if (appConfig.ttsModel !== APP_CONFIG_DEFAULTS.ttsModel) return;

    const patch: Partial<AppConfigRow> = { ttsModel: providerDefaults.defaultModel };
    updateAppConfig(patch).catch((error) => {
      console.warn('Failed to normalize shared-provider default model:', error);
    });
    queueSyncedPreferencePatch(patch);
  }, [isDBReady, appConfig, sharedProviders, queueSyncedPreferencePatch, adminDefaultProviderRef, sharedProvidersLoading]);

  /**
   * Updates multiple configuration values simultaneously
   * Only saves API credentials if they are explicitly set
   */
  const updateConfig = async (newConfig: Partial<{ apiKey: string; baseUrl: string; viewType: ViewType }>) => {
    try {
      setIsLoading(true);
      const updates: Partial<AppConfigRow> = {};
      if (newConfig.apiKey !== undefined) {
        updates.apiKey = newConfig.apiKey;
      }
      if (newConfig.baseUrl !== undefined) {
        updates.baseUrl = newConfig.baseUrl;
      }
      if (newConfig.viewType !== undefined) {
        updates.viewType = newConfig.viewType;
      }
      await updateAppConfig(updates);
      queueSyncedPreferencePatch(updates);
    } catch (error) {
      console.error('Error updating config:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Updates a single configuration value by key
   * @param {K} key - The configuration key to update
   * @param {AppConfigValues[K]} value - The new value for the configuration
   */
  const updateConfigKey = async <K extends keyof AppConfigValues>(key: K, value: AppConfigValues[K]) => {
    try {
      setIsLoading(true);
      const { storagePatch, syncPatch } = applyConfigUpdate({
        providerRef: effectiveProviderRef,
        providerType,
        ttsModel: effectiveTtsModel,
        savedVoices,
      }, key, value);

      await updateAppConfig(storagePatch);
      if (
        key === 'voice' ||
        key === 'providerRef' ||
        key === 'providerType' ||
        key === 'ttsModel' ||
        key === 'savedVoices' ||
        syncedPreferenceKeys.has(String(key))
      ) {
        queueSyncedPreferencePatch(syncPatch);
      }
    } catch (error) {
      console.error(`Error updating config key ${String(key)}:`, error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <ConfigContext.Provider value={{
      apiKey,
      baseUrl,
      viewType,
      voiceSpeed,
      audioPlayerSpeed,
      voice,
      skipBlank,
      epubTheme,
      segmentPreloadDepthPages,
      segmentPreloadSentenceLookahead,
      ttsSegmentMaxBlockLength,
      headerMargin,
      footerMargin,
      leftMargin,
      rightMargin,
      providerRef: effectiveProviderRef,
      providerType,
      ttsModel: effectiveTtsModel,
      ttsInstructions: effectiveTtsInstructions,
      savedVoices,
      updateConfig,
      updateConfigKey,
      isLoading,
      isDBReady,
      pdfHighlightEnabled,
      pdfWordHighlightEnabled,
      epubHighlightEnabled,
      epubWordHighlightEnabled,
      htmlHighlightEnabled,
      htmlWordHighlightEnabled,
    }}>
      {children}
    </ConfigContext.Provider>
  );
}

/**
 * Custom hook to consume the configuration context
 * @returns {ConfigContextType} The configuration context value
 * @throws {Error} When used outside of ConfigProvider
 */
export function useConfig() {
  const context = useContext(ConfigContext);
  if (context === undefined) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
}

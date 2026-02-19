'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, initDB, migrateLegacyDexieDocumentIdsToSha, updateAppConfig } from '@/lib/client/dexie';
import { APP_CONFIG_DEFAULTS, type ViewType, type SavedVoices, type AppConfigValues, type AppConfigRow } from '@/types/config';
import { scheduleUserPreferencesSync, cancelPendingPreferenceSync, getUserPreferences, putUserPreferences } from '@/lib/client/api/user-state';
import { SYNCED_PREFERENCE_KEYS, type SyncedPreferenceKey, type SyncedPreferencesPatch } from '@/types/user-state';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useAuthConfig } from '@/contexts/AuthRateLimitContext';
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
  smartSentenceSplitting: boolean;
  headerMargin: number;
  footerMargin: number;
  leftMargin: number;
  rightMargin: number;
  ttsProvider: string;
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
  const didRunStartupMigrations = useRef(false);
  const didAttemptInitialPreferenceSeedForSession = useRef<string | null>(null);
  const syncedPreferenceKeys = useMemo(() => new Set<string>(SYNCED_PREFERENCE_KEYS), []);
  const { authEnabled } = useAuthConfig();
  const { data: sessionData, isPending: isSessionPending } = useAuthSession();
  const sessionKey = sessionData?.user?.id ?? 'no-session';

  // Helper function to generate provider-model key
  const getVoiceKey = (provider: string, model: string) => `${provider}:${model}`;

  const queueSyncedPreferencePatch = useCallback((patch: Partial<AppConfigValues>) => {
    if (!authEnabled || sessionKey === 'no-session') return;

    const syncedPatch: SyncedPreferencesPatch = {};
    for (const key of SYNCED_PREFERENCE_KEYS) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (value === undefined) continue;
      (syncedPatch as Record<SyncedPreferenceKey, unknown>)[key] = value;
    }
    if (Object.keys(syncedPatch).length === 0) return;
    scheduleUserPreferencesSync(syncedPatch, sessionKey);
  }, [authEnabled, sessionKey]);

  // Cancel pending/in-flight preference syncs whenever the session changes or on unmount.
  useEffect(() => {
    return () => {
      cancelPendingPreferenceSync();
    };
  }, [sessionKey]);

  const buildSyncedPreferencePatch = useCallback((
    source: Partial<AppConfigValues>,
    options?: { nonDefaultOnly?: boolean },
  ): SyncedPreferencesPatch => {
    const out: SyncedPreferencesPatch = {};
    for (const key of SYNCED_PREFERENCE_KEYS) {
      if (!(key in source)) continue;
      const value = source[key];
      if (value === undefined) continue;
      if (options?.nonDefaultOnly) {
        const defaultValue = APP_CONFIG_DEFAULTS[key];
        const same =
          typeof value === 'object'
            ? JSON.stringify(value) === JSON.stringify(defaultValue)
            : value === defaultValue;
        if (same) continue;
      }
      (out as Record<SyncedPreferenceKey, unknown>)[key] = value;
    }
    return out;
  }, []);

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
    if (!isDBReady || !authEnabled) return;
    try {
      const remote = await getUserPreferences({ signal });
      if (!remote?.hasStoredPreferences) return;
      if (!remote.preferences || Object.keys(remote.preferences).length === 0) return;
      await updateAppConfig(remote.preferences as Partial<AppConfigRow>);
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
      console.warn('Failed to load synced preferences:', error);
    }
  }, [isDBReady, authEnabled]);

  useEffect(() => {
    if (!isDBReady || !authEnabled || isSessionPending) return;
    const controller = new AbortController();
    refreshSyncedPreferencesFromServer(controller.signal).catch((error) => {
      if ((error as Error)?.name === 'AbortError') return;
      console.warn('Synced preferences refresh failed:', error);
    });
    return () => controller.abort();
  }, [isDBReady, authEnabled, isSessionPending, sessionKey, refreshSyncedPreferencesFromServer]);

  useEffect(() => {
    if (!isDBReady || !authEnabled) return;
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
  }, [isDBReady, authEnabled, refreshSyncedPreferencesFromServer]);

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
    if (!isDBReady || !authEnabled || !appConfig || isSessionPending) return;
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
  }, [isDBReady, authEnabled, appConfig, buildSyncedPreferencePatch, isSessionPending, sessionKey]);

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
    ttsProvider,
    ttsModel,
    ttsInstructions,
    savedVoices,
    smartSentenceSplitting,
    pdfHighlightEnabled,
    pdfWordHighlightEnabled,
    epubHighlightEnabled,
    epubWordHighlightEnabled,
  } = config || APP_CONFIG_DEFAULTS;

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

      // Special handling for voice - only update savedVoices
      if (key === 'voice') {
        const voiceKey = getVoiceKey(ttsProvider, ttsModel);
        const updatedSavedVoices = { ...savedVoices, [voiceKey]: value as string };
        await updateAppConfig({
          savedVoices: updatedSavedVoices,
          voice: value as string,
        });
        queueSyncedPreferencePatch({
          savedVoices: updatedSavedVoices,
          voice: value as string,
        });
      }
      // Special handling for provider/model changes - restore saved voice if available
      else if (key === 'ttsProvider' || key === 'ttsModel') {
        const newProvider = key === 'ttsProvider' ? (value as string) : ttsProvider;
        const newModel = key === 'ttsModel' ? (value as string) : ttsModel;
        const voiceKey = getVoiceKey(newProvider, newModel);
        const restoredVoice = savedVoices[voiceKey] || '';
        await updateAppConfig({
          [key]: value as AppConfigValues[keyof AppConfigValues],
          voice: restoredVoice,
        } as Partial<AppConfigRow>);
        queueSyncedPreferencePatch({
          [key]: value as AppConfigValues[keyof AppConfigValues],
          voice: restoredVoice,
        } as Partial<AppConfigValues>);
      }
      else if (key === 'savedVoices') {
        const newSavedVoices = value as SavedVoices;
        await updateAppConfig({
          savedVoices: newSavedVoices,
        });
        queueSyncedPreferencePatch({
          savedVoices: newSavedVoices,
        });
      }
      else {
        await updateAppConfig({
          [key]: value as AppConfigValues[keyof AppConfigValues],
        } as Partial<AppConfigRow>);
        if (syncedPreferenceKeys.has(String(key))) {
          queueSyncedPreferencePatch({
            [key]: value,
          } as Partial<AppConfigValues>);
        }
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
      smartSentenceSplitting,
      headerMargin,
      footerMargin,
      leftMargin,
      rightMargin,
      ttsProvider,
      ttsModel,
      ttsInstructions,
      savedVoices,
      updateConfig,
      updateConfigKey,
      isLoading,
      isDBReady,
      pdfHighlightEnabled,
      pdfWordHighlightEnabled,
      epubHighlightEnabled,
      epubWordHighlightEnabled
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

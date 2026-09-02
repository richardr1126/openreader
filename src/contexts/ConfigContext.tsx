'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { APP_CONFIG_DEFAULTS, type ViewType, type SavedVoices, type AppConfigValues } from '@/types/config';
import { resolveProviderDefaults } from '@openreader/tts/provider-policy';
import { useAuthSession } from '@/hooks/useAuthSession';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { applyConfigUpdate } from '@/lib/client/config/updates';
import { useSharedProviders } from '@/hooks/useSharedProviders';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import type { SyncedPreferencesPatch } from '@/types/user-state';

export type { ViewType } from '@/types/config';

interface ConfigContextType {
  viewType: ViewType;
  voiceSpeed: number;
  audioPlayerSpeed: number;
  voice: string;
  epubTheme: boolean;
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
  updateConfigKey: <K extends keyof AppConfigValues>(key: K, value: AppConfigValues[K]) => Promise<void>;
  isLoading: boolean;
  preferencesReady: boolean;
  preferencesError: Error | null;
  pdfHighlightEnabled: boolean;
  pdfWordHighlightEnabled: boolean;
  epubHighlightEnabled: boolean;
  epubWordHighlightEnabled: boolean;
  htmlHighlightEnabled: boolean;
  htmlWordHighlightEnabled: boolean;
}

const ConfigContext = createContext<ConfigContextType | undefined>(undefined);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const { data: session, isPending: isSessionPending } = useAuthSession();
  const sessionId = session?.user?.id ?? 'no-session';
  const { providers: sharedProviders, isLoading: sharedProvidersLoading } = useSharedProviders();
  const adminDefaultProviderRef = useRuntimeConfig().defaultTtsProvider;
  const { query, mutation } = useUserPreferences(sessionId, !isSessionPending);

  const config = useMemo<AppConfigValues>(() => ({
    ...APP_CONFIG_DEFAULTS,
    ...(query.data?.preferences ?? {}),
  }), [query.data?.preferences]);

  const effectiveProvider = useMemo(() => resolveProviderDefaults({
    providerRef: config.providerRef,
    providerType: config.providerType,
    sharedProviders,
    fallbackProviderRef: adminDefaultProviderRef,
  }), [adminDefaultProviderRef, config.providerRef, config.providerType, sharedProviders]);

  const effectiveProviderRef = effectiveProvider.providerRef;
  const effectiveTtsModel = config.ttsModel || effectiveProvider.defaultModel;
  const effectiveTtsInstructions = config.ttsInstructions || effectiveProvider.defaultInstructions;

  const updatePatch = async (patch: Partial<AppConfigValues>) => {
    await mutation.mutateAsync(patch as SyncedPreferencesPatch);
  };

  const updateConfigKey = async <K extends keyof AppConfigValues>(key: K, value: AppConfigValues[K]) => {
    const { syncPatch } = applyConfigUpdate({
      providerRef: effectiveProviderRef,
      providerType: effectiveProvider.providerType,
      ttsModel: effectiveTtsModel,
      savedVoices: config.savedVoices,
    }, key, value);
    await updatePatch(syncPatch);
  };

  const isLoading = isSessionPending || query.isPending || sharedProvidersLoading;

  return (
    <ConfigContext.Provider value={{
      viewType: config.viewType,
      voiceSpeed: config.voiceSpeed,
      audioPlayerSpeed: config.audioPlayerSpeed,
      voice: config.voice,
      epubTheme: config.epubTheme,
      ttsSegmentMaxBlockLength: config.ttsSegmentMaxBlockLength,
      headerMargin: config.headerMargin,
      footerMargin: config.footerMargin,
      leftMargin: config.leftMargin,
      rightMargin: config.rightMargin,
      providerRef: effectiveProviderRef,
      providerType: effectiveProvider.providerType,
      ttsModel: effectiveTtsModel,
      ttsInstructions: effectiveTtsInstructions,
      savedVoices: config.savedVoices,
      updateConfigKey,
      isLoading,
      preferencesReady: !isSessionPending && query.isSuccess,
      preferencesError: query.error,
      pdfHighlightEnabled: config.pdfHighlightEnabled,
      pdfWordHighlightEnabled: config.pdfWordHighlightEnabled,
      epubHighlightEnabled: config.epubHighlightEnabled,
      epubWordHighlightEnabled: config.epubWordHighlightEnabled,
      htmlHighlightEnabled: config.htmlHighlightEnabled,
      htmlWordHighlightEnabled: config.htmlWordHighlightEnabled,
    }}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig() {
  const context = useContext(ConfigContext);
  if (!context) throw new Error('useConfig must be used within a ConfigProvider');
  return context;
}

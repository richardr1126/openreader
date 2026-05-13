import type { AppConfigRow, AppConfigValues, SavedVoices } from '@/types/config';

export function getVoicePreferenceKey(providerRef: string, model: string): string {
  return `${providerRef}:${model}`;
}

export function applyConfigUpdate<K extends keyof AppConfigValues>(
  currentConfig: Pick<AppConfigValues, 'providerRef' | 'providerType' | 'ttsModel' | 'savedVoices'>,
  key: K,
  value: AppConfigValues[K],
): {
  storagePatch: Partial<AppConfigRow>;
  syncPatch: Partial<AppConfigValues>;
} {
  if (key === 'voice') {
    const voiceKey = getVoicePreferenceKey(currentConfig.providerRef, currentConfig.ttsModel);
    const updatedSavedVoices = { ...currentConfig.savedVoices, [voiceKey]: value as string };
    return {
      storagePatch: {
        savedVoices: updatedSavedVoices,
        voice: value as string,
      },
      syncPatch: {
        savedVoices: updatedSavedVoices,
        voice: value as string,
      },
    };
  }

  if (key === 'providerRef' || key === 'ttsModel' || key === 'providerType') {
    const newProviderRef = key === 'providerRef' ? (value as string) : currentConfig.providerRef;
    const newModel = key === 'ttsModel' ? (value as string) : currentConfig.ttsModel;
    const voiceKey = getVoicePreferenceKey(newProviderRef, newModel);
    const restoredVoice = currentConfig.savedVoices[voiceKey] || '';

    return {
      storagePatch: {
        [key]: value as AppConfigValues[keyof AppConfigValues],
        voice: restoredVoice,
      } as Partial<AppConfigRow>,
      syncPatch: {
        [key]: value as AppConfigValues[keyof AppConfigValues],
        voice: restoredVoice,
      } as Partial<AppConfigValues>,
    };
  }

  if (key === 'savedVoices') {
    const newSavedVoices = value as SavedVoices;
    return {
      storagePatch: {
        savedVoices: newSavedVoices,
      },
      syncPatch: {
        savedVoices: newSavedVoices,
      },
    };
  }

  return {
    storagePatch: {
      [key]: value as AppConfigValues[keyof AppConfigValues],
    } as Partial<AppConfigRow>,
    syncPatch: {
      [key]: value,
    } as Partial<AppConfigValues>,
  };
}

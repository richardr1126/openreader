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

/**
 * Applies several keys as one write, in the patch's key order, so a voice set
 * after a provider or model change is remembered under the new provider/model.
 */
export function applyConfigPatch(
  currentConfig: Pick<AppConfigValues, 'providerRef' | 'providerType' | 'ttsModel' | 'savedVoices'>,
  patch: Partial<AppConfigValues>,
): Partial<AppConfigValues> {
  let current = currentConfig;
  let merged: Partial<AppConfigValues> = {};
  for (const key of Object.keys(patch) as Array<keyof AppConfigValues>) {
    const { syncPatch } = applyConfigUpdate(current, key, patch[key] as AppConfigValues[typeof key]);
    merged = { ...merged, ...syncPatch };
    current = {
      providerRef: merged.providerRef ?? current.providerRef,
      providerType: merged.providerType ?? current.providerType,
      ttsModel: merged.ttsModel ?? current.ttsModel,
      savedVoices: merged.savedVoices ?? current.savedVoices,
    };
  }
  return merged;
}

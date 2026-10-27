'use client';

import { useMemo } from 'react';
import { useConfig } from '@/contexts/ConfigContext';
import { toggleFavoriteVoice } from '@/lib/shared/voice-favorites';

export function useVoiceFavorites(providerRef: string, ttsModel: string) {
  const { favoriteVoices, updateConfigKey } = useConfig();
  const voices = useMemo(() => new Set(favoriteVoices
    .filter((entry) => entry.providerRef === providerRef && entry.ttsModel === ttsModel)
    .map((entry) => entry.voice)), [favoriteVoices, providerRef, ttsModel]);
  return {
    voices,
    toggle: async (voice: string) => {
      await updateConfigKey('favoriteVoices', toggleFavoriteVoice(favoriteVoices, { providerRef, ttsModel, voice }));
    },
    available: Boolean(providerRef && ttsModel),
  };
}

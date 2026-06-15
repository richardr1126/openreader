'use client';

import { useState, useCallback, useRef } from 'react';
import { getVoices } from '@/lib/client/api/audiobooks';
import { type TtsProviderType } from '@/lib/shared/tts-provider-catalog';
import { resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';

/**
 * Custom hook for managing TTS voices
 * @param providerRef TTS provider routing reference (built-in id or shared slug)
 * @param providerType Resolved provider type for capability/default logic
 * @param ttsModel TTS model name
 * @returns Object containing available voices and fetch function
 */
export function useVoiceManagement(
  providerRef: string | undefined,
  providerType: TtsProviderType | undefined,
  ttsModel: string | undefined
) {
  const [availableVoices, setAvailableVoices] = useState<string[]>([]);
  const fetchSeqRef = useRef(0);

  const fetchVoices = useCallback(async () => {
    const fetchSeq = ++fetchSeqRef.current;
    try {
      console.log('Fetching voices...');
      const data = await getVoices({
        'x-tts-provider': providerRef || 'openai',
        'x-tts-model': ttsModel || 'tts-1',
        'Content-Type': 'application/json',
      });

      // Ignore stale responses from older provider/model fetches.
      if (fetchSeq !== fetchSeqRef.current) return;
      if (data.voices && data.voices.length > 0) {
        setAvailableVoices(data.voices);
        return;
      }
      setAvailableVoices(resolveTtsProviderModelPolicy({
        providerRef: providerRef || '',
        providerType,
        model: ttsModel || 'tts-1',
      }).defaultVoices);
    } catch (error) {
      console.error('Error fetching voices:', error);
      if (fetchSeq !== fetchSeqRef.current) return;
      setAvailableVoices(resolveTtsProviderModelPolicy({
        providerRef: providerRef || '',
        providerType,
        model: ttsModel || 'tts-1',
      }).defaultVoices);
    }
  }, [providerRef, providerType, ttsModel]);

  return { availableVoices, fetchVoices };
}

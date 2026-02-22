'use client';

import { useState, useCallback, useRef } from 'react';
import { getVoices } from '@/lib/client/api/audiobooks';

const DEFAULT_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer'];

/**
 * Custom hook for managing TTS voices
 * @param apiKey OpenAI API key
 * @param baseUrl OpenAI API base URL
 * @param ttsProvider TTS provider (openai, custom-openai, deepinfra)
 * @param ttsModel TTS model name
 * @returns Object containing available voices and fetch function
 */
export function useVoiceManagement(
  apiKey: string | undefined,
  baseUrl: string | undefined,
  ttsProvider: string | undefined,
  ttsModel: string | undefined
) {
  const [availableVoices, setAvailableVoices] = useState<string[]>([]);
  const fetchSeqRef = useRef(0);

  const fetchVoices = useCallback(async () => {
    const fetchSeq = ++fetchSeqRef.current;
    try {
      console.log('Fetching voices...');
      const data = await getVoices({
        'x-openai-key': apiKey || '',
        'x-openai-base-url': baseUrl || '',
        'x-tts-provider': ttsProvider || 'openai',
        'x-tts-model': ttsModel || 'tts-1',
        'Content-Type': 'application/json',
      });

      // Ignore stale responses from older provider/model fetches.
      if (fetchSeq !== fetchSeqRef.current) return;
      setAvailableVoices(data.voices || DEFAULT_VOICES);
    } catch (error) {
      console.error('Error fetching voices:', error);
      if (fetchSeq !== fetchSeqRef.current) return;
      // Set available voices to default openai voices
      setAvailableVoices(DEFAULT_VOICES);
    }
  }, [apiKey, baseUrl, ttsProvider, ttsModel]);

  return { availableVoices, fetchVoices };
}

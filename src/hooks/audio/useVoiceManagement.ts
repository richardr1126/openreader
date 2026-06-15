'use client';

import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getVoices } from '@/lib/client/api/audiobooks';
import { queryKeys } from '@/lib/client/query-keys';
import { useAuthSession } from '@/hooks/useAuthSession';
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
  ttsModel: string | undefined,
  enabled = true,
) {
  const { data: session, isPending: isSessionPending } = useAuthSession();
  const effectiveProviderRef = providerRef || 'openai';
  const effectiveModel = ttsModel || 'tts-1';
  const fallbackVoices = useMemo(() => resolveTtsProviderModelPolicy({
    providerRef: providerRef || '',
    providerType,
    model: effectiveModel,
  }).defaultVoices, [effectiveModel, providerRef, providerType]);
  const query = useQuery({
    queryKey: queryKeys.ttsVoices(session?.user?.id ?? 'no-session', effectiveProviderRef, effectiveModel),
    queryFn: ({ signal }) => getVoices({
      'x-tts-provider': providerRef || 'openai',
      'x-tts-model': effectiveModel,
      'Content-Type': 'application/json',
    }, signal),
    enabled: enabled && !isSessionPending,
  });
  const availableVoices = query.isPending
    ? []
    : query.data?.voices?.length
      ? query.data.voices
      : fallbackVoices;
  useEffect(() => {
    if (query.error) console.error('Error fetching voices:', query.error);
  }, [query.error]);

  return { availableVoices, query };
}

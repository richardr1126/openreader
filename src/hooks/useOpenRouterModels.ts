'use client';
import { useQuery } from '@tanstack/react-query';
import type { OpenRouterSpeechModel } from '@openreader/tts/openrouter';
import { queryKeys } from '@/lib/client/query-keys';

export function useOpenRouterModels(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.openRouterModels(), enabled, staleTime: 5 * 60_000,
    queryFn: async ({ signal }): Promise<OpenRouterSpeechModel[]> => {
      const response = await fetch('/api/tts/models', { signal });
      if (!response.ok) throw new Error('Could not load OpenRouter speech models');
      return ((await response.json()) as { models: OpenRouterSpeechModel[] }).models;
    },
  });
}

'use client';

import { useEffect, useMemo, useState } from 'react';
import { resolveTtsProviderModelPolicy } from '@openreader/tts/provider-policy';
import type { AppConfigValues } from '@/types/config';

/**
 * The user's default voice and model speed as the reader uses them: the saved
 * values once config loads, with a local (unsaved) fallback voice while the
 * saved one is empty or unavailable for the current model.
 */
export function useDefaultVoice(input: {
  configIsLoading: boolean;
  configVoice: string;
  voiceSpeed: number;
  availableVoices: string[];
  providerRef: string;
  providerType: AppConfigValues['providerType'];
  ttsModel: string;
}): { voice: string; speed: number } {
  const { configIsLoading, configVoice, voiceSpeed, availableVoices, providerRef, providerType, ttsModel } = input;
  const [speed, setSpeed] = useState(voiceSpeed);
  const [voice, setVoice] = useState(configVoice);
  const policy = useMemo(
    () => resolveTtsProviderModelPolicy({ providerRef, providerType, model: ttsModel }),
    [providerRef, providerType, ttsModel],
  );

  useEffect(() => {
    if (configIsLoading) return;
    setVoice(configVoice);
    setSpeed(voiceSpeed);
  }, [configIsLoading, configVoice, voiceSpeed]);

  useEffect(() => {
    if (availableVoices.length === 0) return;
    // Allow Kokoro multi-voice strings (e.g., "voice1(0.5)+voice2(0.5)") for any provider
    const fallbackVoice = configVoice || availableVoices[0];
    if (policy.isKokoroModel && !policy.isResolvedProviderType && voice.includes('+')) {
      const firstVoice = voice.split('+')[0]?.replace(/\([^)]*\)/g, '').trim();
      if (firstVoice) setVoice(firstVoice);
      return;
    }
    // Kokoro keeps any voice string (including plus/weights). Otherwise a
    // persisted voice is kept rather than overridden from a potentially stale
    // in-flight voices response during reload; only an empty voice, or an
    // unsaved one the model lacks, falls back (locally, never saved).
    if (!voice) {
      setVoice(fallbackVoice);
      return;
    }
    if (!policy.isKokoroModel && !configVoice && !availableVoices.includes(voice)) {
      setVoice(availableVoices[0]);
    }
  }, [availableVoices, voice, configVoice, policy]);

  return { voice, speed };
}

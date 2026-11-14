'use client';

import { useMemo, useState } from 'react';
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

  // The loaded config replaces the local voice and speed whenever it changes.
  const [configured, setConfigured] = useState<{ voice: string; speed: number } | null>(null);
  if (!configIsLoading && (configured?.voice !== configVoice || configured.speed !== voiceSpeed)) {
    setConfigured({ voice: configVoice, speed: voiceSpeed });
    setVoice(configVoice);
    setSpeed(voiceSpeed);
  }

  const usableVoice = resolveUsableVoice(voice, configVoice, availableVoices, policy);
  if (usableVoice !== voice) setVoice(usableVoice);

  return { voice, speed };
}

/**
 * Kokoro keeps any voice string (including plus/weights), except that a
 * provider without multi-voice support speaks the first voice. Otherwise a
 * persisted voice is kept rather than overridden from a potentially stale
 * in-flight voices response during reload; only an empty voice, or an unsaved
 * one the model lacks, falls back (locally, never saved).
 */
function resolveUsableVoice(
  voice: string,
  configVoice: string,
  availableVoices: string[],
  policy: ReturnType<typeof resolveTtsProviderModelPolicy>,
): string {
  if (availableVoices.length === 0) return voice;
  if (policy.isKokoroModel && !policy.isResolvedProviderType && voice.includes('+')) {
    return voice.split('+')[0]?.replace(/\([^)]*\)/g, '').trim() || voice;
  }
  if (!voice) return configVoice || availableVoices[0];
  if (!policy.isKokoroModel && !configVoice && !availableVoices.includes(voice)) return availableVoices[0];
  return voice;
}

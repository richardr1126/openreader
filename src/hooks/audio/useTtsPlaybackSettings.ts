'use client';

import { useCallback, type MutableRefObject } from 'react';

import type { TTSSentenceAlignment } from '@/types/tts';
import type { AppConfigValues } from '@/types/config';

type UseTtsPlaybackSettingsInput = {
  isPlaying: boolean;
  restartSeqRef: MutableRefObject<number>;
  sentenceAlignmentCacheRef: MutableRefObject<Map<string, TTSSentenceAlignment>>;
  abortAudio: () => void;
  resetPlaybackPlan: (options?: { resetSelection?: boolean; resetSeekLayout?: boolean }) => void;
  setAudioSpeed: (speed: number) => void;
  setCurrentSentenceAlignment: (alignment: TTSSentenceAlignment | undefined) => void;
  setCurrentWordIndex: (wordIndex: number | null) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setIsProcessing: (isProcessing: boolean) => void;
  setSpeed: (speed: number) => void;
  setVoice: (voice: string) => void;
  updateConfigKey: <K extends keyof AppConfigValues>(key: K, value: AppConfigValues[K]) => Promise<void>;
};

export function useTtsPlaybackSettings(input: UseTtsPlaybackSettingsInput) {
  const {
    isPlaying,
    restartSeqRef,
    sentenceAlignmentCacheRef,
    abortAudio,
    resetPlaybackPlan,
    setAudioSpeed,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    setIsPlaying,
    setIsProcessing,
    setSpeed,
    setVoice,
    updateConfigKey,
  } = input;

  const clearSegmentCaches = useCallback(() => {
    const wasPlaying = isPlaying;
    const sequence = ++restartSeqRef.current;
    resetPlaybackPlan({ resetSelection: false });
    abortAudio();
    sentenceAlignmentCacheRef.current.clear();
    setCurrentSentenceAlignment(undefined);
    setCurrentWordIndex(null);
    if (!wasPlaying) return;
    setIsProcessing(true);
    setIsPlaying(false);
    window.setTimeout(() => {
      setIsProcessing(false);
      if (sequence === restartSeqRef.current) setIsPlaying(true);
    }, 0);
  }, [
    abortAudio,
    isPlaying,
    resetPlaybackPlan,
    restartSeqRef,
    sentenceAlignmentCacheRef,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    setIsPlaying,
    setIsProcessing,
  ]);

  const restartAfterConfigUpdate = useCallback(async (
    applyLocalState: () => void,
    update: () => Promise<void>,
    options: { resetPlan: boolean },
  ) => {
    const wasPlaying = isPlaying;
    const sequence = ++restartSeqRef.current;
    setIsProcessing(true);
    setIsPlaying(false);
    abortAudio();
    if (options.resetPlan) resetPlaybackPlan({ resetSelection: false });
    applyLocalState();
    await update();
    setIsProcessing(false);
    if (wasPlaying && sequence === restartSeqRef.current) setIsPlaying(true);
  }, [
    abortAudio,
    isPlaying,
    resetPlaybackPlan,
    restartSeqRef,
    setIsPlaying,
    setIsProcessing,
  ]);

  const setSpeedAndRestart = useCallback((speed: number) => {
    void restartAfterConfigUpdate(
      () => setSpeed(speed),
      () => updateConfigKey('voiceSpeed', speed),
      { resetPlan: true },
    );
  }, [restartAfterConfigUpdate, setSpeed, updateConfigKey]);

  const setVoiceAndRestart = useCallback((voice: string) => {
    void restartAfterConfigUpdate(
      () => setVoice(voice),
      () => updateConfigKey('voice', voice),
      { resetPlan: true },
    );
  }, [restartAfterConfigUpdate, setVoice, updateConfigKey]);

  const setAudioPlayerSpeedAndRestart = useCallback((speed: number) => {
    void restartAfterConfigUpdate(
      () => setAudioSpeed(speed),
      () => updateConfigKey('audioPlayerSpeed', speed),
      { resetPlan: false },
    );
  }, [restartAfterConfigUpdate, setAudioSpeed, updateConfigKey]);

  const invalidatePlaybackPlan = useCallback(() => {
    const wasPlaying = isPlaying;
    const sequence = ++restartSeqRef.current;
    resetPlaybackPlan({ resetSelection: false });
    if (!wasPlaying) return;
    setIsProcessing(true);
    setIsPlaying(false);
    abortAudio();
    window.setTimeout(() => {
      setIsProcessing(false);
      if (sequence === restartSeqRef.current) setIsPlaying(true);
    }, 0);
  }, [abortAudio, isPlaying, resetPlaybackPlan, restartSeqRef, setIsPlaying, setIsProcessing]);

  return {
    clearSegmentCaches,
    invalidatePlaybackPlan,
    setAudioPlayerSpeedAndRestart,
    setSpeedAndRestart,
    setVoiceAndRestart,
  };
}

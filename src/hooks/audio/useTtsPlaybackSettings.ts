'use client';

import { useCallback, type MutableRefObject } from 'react';
import toast from 'react-hot-toast';

import type { TTSSentenceAlignment } from '@/types/tts';
import type { AppConfigValues } from '@/types/config';
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings } from '@/types/document-settings';
import { putDocumentSettings } from '@/lib/client/api/documents';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import type { SpeechTextOptions } from '@openreader/tts/speech-text';

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
  documentId: string | null;
  readerSettings: DocumentSettings | null;
  setReaderSettings: (settings: DocumentSettings) => void;
  providerRef: string;
  ttsModel: string;
  defaultVoice: string;
  defaultVoiceSpeed: number;
  updateConfigKey: <K extends keyof AppConfigValues>(key: K, value: AppConfigValues[K]) => Promise<void>;
  reacquirePlaybackPlan: () => Promise<void>;
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
    documentId,
    readerSettings,
    setReaderSettings,
    providerRef,
    ttsModel,
    defaultVoice,
    defaultVoiceSpeed,
    updateConfigKey,
    reacquirePlaybackPlan,
  } = input;

  const clearSegmentCaches = useCallback(() => {
    const wasPlaying = isPlaying;
    restartSeqRef.current += 1;
    resetPlaybackPlan({ resetSelection: false });
    abortAudio();
    sentenceAlignmentCacheRef.current.clear();
    setCurrentSentenceAlignment(undefined);
    setCurrentWordIndex(null);
    if (wasPlaying) {
      setIsProcessing(true);
      setIsPlaying(false);
    }
    void reacquirePlaybackPlan().finally(() => {
      setIsProcessing(false);
    });
  }, [
    abortAudio,
    isPlaying,
    resetPlaybackPlan,
    restartSeqRef,
    reacquirePlaybackPlan,
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
    if (options.resetPlan) await reacquirePlaybackPlan();
    setIsProcessing(false);
    if (!options.resetPlan && wasPlaying && sequence === restartSeqRef.current) {
      setIsPlaying(true);
    }
  }, [
    abortAudio,
    isPlaying,
    reacquirePlaybackPlan,
    resetPlaybackPlan,
    restartSeqRef,
    setIsPlaying,
    setIsProcessing,
  ]);

  /**
   * Changes this book's own voice and/or model speed as one restart: a single
   * plan reset and reacquire. `null` returns that field to the user's default,
   * and a value equal to the default is not stored as an override.
   */
  const setBookVoiceAndRestart = useCallback((change: { voice?: string | null; nativeSpeed?: number | null }) => {
    if (!documentId || !readerSettings) return;
    if (change.voice === undefined && change.nativeSpeed === undefined) return;
    const current = readerSettings.voiceOverride;
    const matching = current?.providerRef === providerRef && current.ttsModel === ttsModel ? current : undefined;
    const pick = <T,>(next: T | null | undefined, existing: T | undefined, fallback: T): T | undefined => {
      const value = next === undefined ? existing : next ?? undefined;
      return value === fallback ? undefined : value;
    };
    const next = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {
      ...readerSettings,
      voiceOverride: {
        providerRef,
        ttsModel,
        voice: pick(change.voice, matching?.voice, defaultVoice),
        voiceSpeed: pick(change.nativeSpeed, matching?.voiceSpeed, defaultVoiceSpeed),
      },
    });
    const previous = readerSettings;
    void restartAfterConfigUpdate(
      () => setReaderSettings(next),
      async () => {
        // A failed save rolls back here instead of throwing, so the restart
        // still reacquires the plan and clears processing.
        try {
          // The audio controller's snapshot does not own live font/color edits.
          // Omit those fields so the server preserves their latest values.
          await putDocumentSettings(documentId, { ...next, typography: undefined, highlightAppearance: undefined });
        } catch (error) {
          console.error('Could not save book voice:', error);
          setReaderSettings(previous);
          toast.error('Could not save this book\'s voice');
        }
      },
      { resetPlan: true },
    );
  }, [
    defaultVoice,
    defaultVoiceSpeed,
    documentId,
    providerRef,
    readerSettings,
    restartAfterConfigUpdate,
    setReaderSettings,
    ttsModel,
  ]);

  const setAudioPlayerSpeedAndRestart = useCallback((speed: number) => {
    // Browser playback rate is deliberately not part of the generated-audio
    // plan. Changing it must leave the active media stream, canonical session,
    // and play intent alone; aborting the stream here leaves an "is playing"
    // state with no source to resume.
    setAudioSpeed(speed);
    void updateConfigKey('audioPlayerSpeed', speed).catch((error: unknown) => {
      console.error('Could not save audio player speed preference:', error);
    });
  }, [setAudioSpeed, updateConfigKey]);

  const setBookSpeechText = useCallback((speechText: Partial<SpeechTextOptions>) => {
    if (!documentId || !readerSettings) return;
    const previous = readerSettings;
    const next = { ...readerSettings, speechText };
    void restartAfterConfigUpdate(() => setReaderSettings(next), async () => {
      try {
        await putDocumentSettings(documentId, { ...next, typography: undefined, highlightAppearance: undefined });
      } catch (error) {
        console.error('Could not save speech settings:', error);
        setReaderSettings(previous);
        toast.error('Could not save this book’s speech settings');
      }
    }, { resetPlan: true });
  }, [documentId, readerSettings, restartAfterConfigUpdate, setReaderSettings]);

  return {
    clearSegmentCaches,
    setAudioPlayerSpeedAndRestart,
    setBookVoiceAndRestart,
    setBookSpeechText,
  };
}

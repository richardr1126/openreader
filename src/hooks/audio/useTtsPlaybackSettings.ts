'use client';

import { useCallback, useRef, type MutableRefObject } from 'react';
import toast from 'react-hot-toast';
import { useQueryClient } from '@tanstack/react-query';

import type { TTSSentenceAlignment } from '@/types/tts';
import type { AppConfigValues } from '@/types/config';
import type { TtsProviderType } from '@openreader/tts/provider-catalog';
import { DEFAULT_DOCUMENT_SETTINGS, type DocumentSettings, type BookSpeechSettings } from '@/types/document-settings';
import { putDocumentSettings } from '@/lib/client/api/documents';
import { mergeDocumentSettings } from '@/lib/shared/document-settings';
import { queryKeys } from '@/lib/client/query-keys';

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
  /** Reports the settings the server acknowledged, so later reader writes build on them. */
  onSettingsSaved: (settings: DocumentSettings) => void;
  providerRef: string;
  providerType: TtsProviderType;
  ttsModel: string;
  /** The saved instructions and model options, restored if a provider switch has to be undone. */
  ttsInstructions: string;
  ttsModelOptions: string;
  defaultVoice: string;
  defaultVoiceSpeed: number;
  updateConfigKey: <K extends keyof AppConfigValues>(key: K, value: AppConfigValues[K]) => Promise<void>;
  updateConfig: (patch: Partial<AppConfigValues>) => Promise<void>;
  reacquirePlaybackPlan: () => Promise<void>;
};

export type BookVoiceChange = {
  voice?: string | null;
  nativeSpeed?: number | null;
  /** The provider and model the voice belongs to, when it is not the current one. */
  target?: { providerRef: string; providerType: TtsProviderType; ttsModel: string };
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
    onSettingsSaved,
    providerRef,
    providerType,
    ttsModel,
    ttsInstructions,
    ttsModelOptions,
    defaultVoice,
    defaultVoiceSpeed,
    updateConfigKey,
    updateConfig,
    reacquirePlaybackPlan,
  } = input;
  /** The latest book voice change; an older one that fails must not undo it. */
  const voiceChangeSeq = useRef(0);
  const queryClient = useQueryClient();

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
   *
   * A `target` on another provider or model first switches the saved provider
   * and model (for every book, as Settings does), then binds this book's voice
   * to it. Its values are stored as given, since the defaults belong to the
   * provider being left.
   */
  const setBookVoiceAndRestart = useCallback((change: BookVoiceChange) => {
    if (!documentId || !readerSettings) return;
    if (change.voice === undefined && change.nativeSpeed === undefined) return;
    const switching = change.target
      && (change.target.providerRef !== providerRef || change.target.ttsModel !== ttsModel)
      ? change.target : null;
    const boundRef = switching?.providerRef ?? providerRef;
    const boundModel = switching?.ttsModel ?? ttsModel;
    const current = readerSettings.voiceOverride;
    const matching = current?.providerRef === boundRef && current.ttsModel === boundModel ? current : undefined;
    const pick = <T,>(next: T | null | undefined, existing: T | undefined, fallback: T): T | undefined => {
      const value = next === undefined ? existing : next ?? undefined;
      return !switching && value === fallback ? undefined : value;
    };
    const next = mergeDocumentSettings(DEFAULT_DOCUMENT_SETTINGS, {
      ...readerSettings,
      voiceOverride: {
        providerRef: boundRef,
        ttsModel: boundModel,
        voice: pick(change.voice, matching?.voice, defaultVoice),
        voiceSpeed: pick(change.nativeSpeed, matching?.voiceSpeed, defaultVoiceSpeed),
      },
    });
    const previous = readerSettings;
    const seq = ++voiceChangeSeq.current;
    void restartAfterConfigUpdate(
      () => setReaderSettings(next),
      async () => {
        // A failed save rolls back here instead of throwing, so the restart
        // still reacquires the plan and clears processing.
        let switched = false;
        try {
          if (switching) {
            // The new provider's own instructions and options, as the cached-voice
            // check assumed: the ones saved for the provider being left would
            // name different audio.
            await updateConfig({ providerRef: switching.providerRef, providerType: switching.providerType, ttsModel: switching.ttsModel,
              ttsInstructions: '', ttsModelOptions: '' });
            switched = true;
          }
          // The audio controller's snapshot does not own live font/color edits.
          // Omit those fields so the server preserves their latest values.
          const saved = await putDocumentSettings(documentId, { ...next, typography: undefined, highlightAppearance: undefined, presentation: undefined });
          onSettingsSaved(saved.settings);
        } catch (error) {
          console.error('Could not save book voice:', error);
          toast.error('Could not save this book\'s voice');
          // A newer change has already replaced this one's settings and provider.
          if (seq !== voiceChangeSeq.current) return;
          setReaderSettings(previous);
          // Other books follow the saved provider, so a switch made for this
          // book must not outlive the save it was made for.
          if (switched) {
            await updateConfig({ providerRef, providerType, ttsModel, ttsInstructions, ttsModelOptions }).catch((restoreError: unknown) => {
              console.error('Could not restore the previous provider:', restoreError);
            });
          }
        }
      },
      { resetPlan: true },
    );
  }, [
    defaultVoice,
    defaultVoiceSpeed,
    documentId,
    onSettingsSaved,
    providerRef,
    providerType,
    readerSettings,
    restartAfterConfigUpdate,
    setReaderSettings,
    ttsInstructions,
    ttsModel,
    ttsModelOptions,
    updateConfig,
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

  const setBookSpeechSettings = useCallback(async (change: BookSpeechSettings): Promise<boolean> => {
    if (!documentId || !readerSettings) return false;
    const previous = readerSettings;
    const next = { ...readerSettings, ...change };
    let saved = false;
    await restartAfterConfigUpdate(() => setReaderSettings(next), async () => {
      try {
        const result = await putDocumentSettings(documentId, { ...next, typography: undefined, highlightAppearance: undefined, presentation: undefined });
        onSettingsSaved(result.settings);
        saved = true;
        // Which cached audio a voice reuses depends on these settings.
        void queryClient.invalidateQueries({ queryKey: queryKeys.allCachedVoices() });
      } catch (error) {
        console.error('Could not save book speech settings:', error);
        setReaderSettings(previous);
        toast.error('Could not save this book’s speech settings');
      }
    }, { resetPlan: true });
    return saved;
  }, [documentId, onSettingsSaved, queryClient, readerSettings, restartAfterConfigUpdate, setReaderSettings]);

  return {
    clearSegmentCaches,
    setAudioPlayerSpeedAndRestart,
    setBookVoiceAndRestart,
    setBookSpeechSettings,
  };
}

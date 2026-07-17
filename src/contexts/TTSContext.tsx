/**
 * Text-to-Speech (TTS) Context Provider
 * 
 * This module provides a React context for managing text-to-speech functionality.
 * Playback is driven by server-created playback sessions backed by the compute worker.
 * 
 * Key features:
 * - Audio playback control (play/pause/skip)
 * - Worker-backed progressive MP3 playback session orchestration
 * - Voice and speed control
 * - Document navigation
 */

'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
  ReactNode,
  ReactElement
} from 'react';
import { useParams, usePathname } from 'next/navigation';

import { useConfig } from '@/contexts/ConfigContext';
import { useVoiceManagement } from '@/hooks/audio/useVoiceManagement';
import { useMediaSession } from '@/hooks/audio/useMediaSession';
import { useAudioContext } from '@/hooks/audio/useAudioContext';
import { useTtsPlayback } from '@/hooks/audio/useTtsPlayback';
import { useTtsDocumentNavigation, type SetTtsTextOptions } from '@/hooks/audio/useTtsDocumentNavigation';
import { useTtsDocumentExport, type TtsDocumentAudioExportResolution } from '@/hooks/audio/useTtsDocumentExport';
import { useTtsPlanController } from '@/hooks/audio/useTtsPlanController';
import { useTtsPlaybackModel } from '@/hooks/audio/useTtsPlaybackModel';
import { useTtsPlaybackSettings } from '@/hooks/audio/useTtsPlaybackSettings';
import type { TtsPlaybackSeekLayout } from '@/lib/client/api/tts';
import {
  pdfLocatorPage,
  type PlaybackAnchor,
} from '@/lib/client/tts/playback-selection';
import {
  type CanonicalTtsSegment,
} from '@openreader/tts/segment-plan';
import { resolveTtsProviderModelPolicy } from '@openreader/tts/provider-policy';
import { resolveTtsLanguage } from '@openreader/tts/language';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import type {
  TTSLocation,
  TTSPlaybackState,
  TTSSentenceAlignment,
} from '@/types/tts';
import type {
  TTSRequestHeaders,
  TTSSegmentLocator,
} from '@/types/client';
import type { ParsedPdfBlockKind } from '@/types/parsed-pdf';

import type { ReaderType } from '@/types/user-state';

// Media globals
declare global {
  interface Window {
    webkitAudioContext: typeof AudioContext;
  }
}

/**
 * Interface defining all available methods and properties in the TTS context
 */
interface TTSContextType extends TTSPlaybackState {
  // Voice settings
  voice: string;
  availableVoices: string[];

  // Current playback plan text and cursor
  sentences: string[];
  currentSentenceOrdinal: number | null;
  playbackTimeSec: number;
  playbackDurationSec: number;
  playbackSeekLayout: TtsPlaybackSeekLayout | null;
  resolveDocumentAudioExport: (options: { format: 'mp3' | 'm4b'; speed: number }, signal?: AbortSignal) => Promise<TtsDocumentAudioExportResolution>;
  startDocumentAudioExport: (options: { format: 'mp3' | 'm4b'; speed: number }, signal?: AbortSignal) => Promise<TtsDocumentAudioExportResolution>;

  // Alignment metadata for the current sentence
  currentSentenceAlignment?: TTSSentenceAlignment;
  currentWordIndex?: number | null;

  // Control functions
  togglePlay: () => void;
  skipForward: () => void;
  skipBackward: () => void;
  pause: () => void;
  stop: () => void;
  seekPlaybackTo: (seconds: number) => void;
  setText: (text: string, options?: boolean | SetTtsTextOptions) => void;
  setDocumentPlaybackAnchor: (location: TTSLocation, hasReadableText: boolean, locator?: TTSSegmentLocator | null) => void;
  setCurrDocPages: (num: number | undefined) => void;
  setSpeedAndRestart: (speed: number) => void;
  setAudioPlayerSpeedAndRestart: (speed: number) => void;
  setVoiceAndRestart: (voice: string) => void;
  /** Drop the cached playback plan after a segmentation change (block kinds / language). */
  invalidatePlaybackPlan: () => void;
  setPdfSkipBlockKinds: (kinds: ParsedPdfBlockKind[] | null) => void;
  documentLanguage: string;
  resolvedLanguage: string;
  setDocumentLanguage: (language: string) => void;
  clearSegmentCaches: () => void;
  skipToLocation: (location: TTSLocation, shouldPause?: boolean) => void;
  prepareInitialPosition: (location: TTSLocation) => void;
  registerLocationChangeHandler: (handler: ((location: TTSLocation | TTSSegmentLocator) => void) | null) => void;  // EPUB-only: Handles chapter navigation
  setIsEPUB: (isEPUB: boolean) => void;
  /** Effective reader type used for worker playback/session scoping. */
  activeReaderType: ReaderType;
}

// Create the context
const TTSContext = createContext<TTSContextType | undefined>(undefined);

/**
 * Main provider component that manages the TTS state and functionality.
 * Handles initialization of audio context, media session, and playback.
 * 
 * @param {Object} props - Component props
 * @param {ReactNode} props.children - Child components to be wrapped by the provider
 * @returns {JSX.Element} TTSProvider component
 */
export function TTSProvider({ children }: { children: ReactNode }): ReactElement {
  // Configuration context consumption
  const {
    isLoading: configIsLoading,
    voiceSpeed,
    audioPlayerSpeed,
    voice: configVoice,
    providerRef: configProviderRef,
    providerType: configProviderType,
    ttsModel: configTTSModel,
    ttsInstructions: configTTSInstructions,
    updateConfigKey,
    skipBlank,
    ttsSegmentMaxBlockLength,
  } = useConfig();

  // Audio and voice management hooks
  const audioContext = useAudioContext();
  const { availableVoices } = useVoiceManagement(
    configProviderRef,
    configProviderType,
    configTTSModel,
  );
  useAuthRateLimit();

  // Get document ID and reader type from URL
  const { id } = useParams();
  const pathname = usePathname();
  const documentId = useMemo(() => {
    if (typeof id === 'string') return id;
    if (Array.isArray(id)) return id[0];
    return '';
  }, [id]);
  const currentReaderType: ReaderType = useMemo(() => {
    if (pathname.startsWith('/epub/')) return 'epub';
    if (pathname.startsWith('/html/')) return 'html';
    return 'pdf';
  }, [pathname]);

  // Add ref for location change handler
  const locationChangeHandlerRef = useRef<((location: TTSLocation | TTSSegmentLocator) => void) | null>(null);

  /**
   * Registers a handler function for location changes in EPUB documents
   * This is only used for EPUB documents to handle chapter navigation
   *
   * @param {Function} handler - Function to handle location changes
   */
  const registerLocationChangeHandler = useCallback((handler: ((location: TTSLocation | TTSSegmentLocator) => void) | null) => {
    locationChangeHandlerRef.current = handler;
  }, []);

  /**
   * State Management
   */
  const [isPlaying, setIsPlaying] = useState(false);
  const [isEPUB, setIsEPUB] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  /**
   * Resolved reader type for playback/session scoping. Consumers use this to
   * interpret worker-plan locators and merge persisted manifest status.
   */
  const activeReaderType: ReaderType = useMemo(
    () => (isEPUB ? 'epub' : currentReaderType),
    [isEPUB, currentReaderType],
  );

  const [currDocPage, setCurrDocPage] = useState<TTSLocation>(1);
  const currDocPageNumber = (!isEPUB ? parseInt(currDocPage.toString()) : 1); // PDF uses numbers only
  const [currDocPages, setCurrDocPages] = useState<number>();

  const {
    playbackPlanRef,
    playbackSegmentsRef,
    selectedOrdinalRef,
    playbackPlanSource,
    sentences,
    currentIndex,
    currentSentence,
    currentSegment,
    selectedOrdinal,
    playbackSeekLayout,
    applyWorkerPlan,
    clearPlaybackSegments,
    resetPlaybackPlan,
    setSelectedOrdinal,
    setPlaybackSeekLayout,
  } = useTtsPlaybackModel();
  const [speed, setSpeed] = useState(voiceSpeed);
  const [audioSpeed, setAudioSpeed] = useState(audioPlayerSpeed);
  const [voice, setVoice] = useState(configVoice);
  const [ttsModel, setTTSModel] = useState(configTTSModel);
  const [ttsInstructions, setTTSInstructions] = useState(configTTSInstructions);
  const [documentLanguage, setDocumentLanguage] = useState('auto');
  const [pdfSkipBlockKinds, setPdfSkipBlockKinds] = useState<ParsedPdfBlockKind[] | null>(null);
  const resolvedLanguage = useMemo(
    () => resolveTtsLanguage({ configuredLanguage: documentLanguage, voice }),
    [documentLanguage, voice],
  );
  const providerModelPolicy = useMemo(
    () => resolveTtsProviderModelPolicy({
      providerRef: configProviderRef,
      providerType: configProviderType,
      model: ttsModel,
    }),
    [configProviderRef, configProviderType, ttsModel],
  );
  const configModelPolicy = useMemo(
    () => resolveTtsProviderModelPolicy({
      providerRef: configProviderRef,
      providerType: configProviderType,
      model: configTTSModel,
    }),
    [configProviderRef, configProviderType, configTTSModel],
  );
  const effectiveNativeSpeed = useMemo(
    () => (providerModelPolicy.supportsNativeModelSpeed ? speed : 1),
    [providerModelPolicy.supportsNativeModelSpeed, speed],
  );

  const playbackRunIdRef = useRef(0);
  // EPUB-only jump resolution. epub.js navigation snaps CFIs to page-aligned
  // values, so carry a stable locator through the next rendered text update.
  const pendingEpubJumpRef = useRef<{ epoch: number; locator?: TTSSegmentLocator | null } | null>(null);
  const epubJumpEpochRef = useRef<number>(0);
  // Guard to coalesce rapid restarts and only resume the latest change
  const restartSeqRef = useRef(0);
  // Preserve autoplay intent across location changes. Some browsers can emit pause
  // events while we stop/unload between pages, which momentarily flips `isPlaying`
  // false and can prevent automatic resume on the next page.
  const resumeAfterLocationChangeRef = useRef(false);
  const sentenceAlignmentCacheRef = useRef<Map<string, TTSSentenceAlignment>>(new Map());
  const [currentSentenceAlignment, setCurrentSentenceAlignment] = useState<TTSSentenceAlignment | undefined>();
  const [currentWordIndex, setCurrentWordIndex] = useState<number | null>(null);
  const isPlayingRef = useRef(false);
  const pauseEpochRef = useRef(0);
  const playbackAnchorRef = useRef<PlaybackAnchor | null>(null);
  const [playbackAnchor, setPlaybackAnchor] = useState<PlaybackAnchor | null>(null);
  const playbackSyncNavigationRef = useRef(false);
  // The single "make the view follow the cursor" primitive. Used identically by
  // live playback (projection), the scrubber, and skip — so paused skip turns the
  // page exactly like playback. It does NOT depend on playback being active.
  const syncPlaybackLocator = useCallback((locator: TTSSegmentLocator | null) => {
    if (!locator) return;
    const page = pdfLocatorPage(locator);
    if (page !== null) {
      playbackSyncNavigationRef.current = true;
      setCurrDocPage(page);
      return;
    }
    if (locator.readerType === 'epub') {
      const handler = locationChangeHandlerRef.current;
      if (!handler) return;
      playbackSyncNavigationRef.current = true;
      handler(locator);
    }
  }, []);

  const selectPlaybackSegment = useCallback((segment: CanonicalTtsSegment | null | undefined): boolean => {
    const ordinal = Number(segment?.ordinal);
    if (!Number.isFinite(ordinal)) return false;
    setSelectedOrdinal(Math.max(0, Math.floor(ordinal)));
    return true;
  }, [setSelectedOrdinal]);

  const advanceRef = useRef<((backwards?: boolean) => void | Promise<void>) | null>(null);
  const playbackPlanRequest = useMemo(() => {
    if (!documentId) return null;
    const headers: TTSRequestHeaders = {
      'Content-Type': 'application/json',
      'x-tts-provider': configProviderRef,
    };
    return {
      headers,
      payload: {
        documentId,
        settings: {
          providerRef: configProviderRef,
          providerType: configProviderType,
          ttsModel,
          voice,
          nativeSpeed: effectiveNativeSpeed,
          ...(providerModelPolicy.supportsInstructions && ttsInstructions ? { ttsInstructions } : {}),
          language: resolvedLanguage,
        },
        planning: {
          maxBlockLength: ttsSegmentMaxBlockLength,
          language: resolvedLanguage,
          ...(activeReaderType === 'pdf' && pdfSkipBlockKinds ? { skipBlockKinds: pdfSkipBlockKinds } : {}),
        },
      },
    };
  }, [
    activeReaderType,
    configProviderRef,
    configProviderType,
    documentId,
    effectiveNativeSpeed,
    pdfSkipBlockKinds,
    providerModelPolicy.supportsInstructions,
    resolvedLanguage,
    ttsInstructions,
    ttsModel,
    ttsSegmentMaxBlockLength,
    voice,
  ]);
  const {
    applyPlaybackPlan,
    buildPlaybackPlanRequest,
    buildPlaybackSessionRequest,
    createAndApplyPlaybackPlan,
    ensurePlaybackPlan,
  } = useTtsPlanController({
    activeReaderType,
    currentLocation: currDocPage,
    currentPdfPage: currDocPageNumber,
    isPlaying,
    playbackAnchor,
    playbackAnchorRef,
    playbackPlanRef,
    playbackPlanSource,
    playbackSeekLayout,
    request: playbackPlanRequest,
    selectedOrdinalRef,
    applyWorkerPlan,
    setPlaybackSeekLayout,
    setSelectedOrdinal,
  });
  const { resolveDocumentAudioExport, startDocumentAudioExport } = useTtsDocumentExport({
    playbackPlanRef,
    applyWorkerPlan,
    buildPlaybackPlanRequest,
    ensurePlaybackPlan,
  });
  const playbackController = useMemo(() => ({
    applyPlaybackPlan,
    buildPlaybackPlanRequest,
    buildPlaybackSessionRequest,
    createAndApplyPlaybackPlan,
  }), [
    applyPlaybackPlan,
    buildPlaybackPlanRequest,
    buildPlaybackSessionRequest,
    createAndApplyPlaybackPlan,
  ]);

  const {
    unlockedAudioRef,
    playbackActiveRef,
    playbackTimeSec,
    publishPlaybackTimeSec,
    abortAudio: controllerAbortAudio,
    cancelSeekResync: controllerCancelSeekResync,
    invalidatePlaybackRun: controllerInvalidatePlaybackRun,
    pauseActivePlayback: controllerPauseActivePlayback,
    seekPlaybackTo: controllerSeekPlaybackTo,
    seekPlaybackToOrdinal: controllerSeekPlaybackToOrdinal,
    togglePlay: controllerTogglePlay,
  } = useTtsPlayback({
    audioContext: audioContext ?? null,
    audioSpeed,
    canStartPlayback: isPlaying && (Boolean(sentences[currentIndex]) || Boolean(playbackAnchorRef.current?.hasContent || playbackAnchorRef.current?.text.trim())),
    isPlaying,
    isPlayingRef,
    playbackSegmentsRef,
    playbackSeekLayout,
    selectedOrdinalRef,
    playbackRunIdRef,
    setIsPlaying,
    setIsProcessing,
    setCurrDocPage,
    syncPlaybackLocator,
    setSelectedOrdinal,
    setPlaybackSeekLayout,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    onAdvance: () => advanceRef.current?.(),
    controller: playbackController,
  });

  const abortAudio = controllerAbortAudio;
  const cancelSeekResync = controllerCancelSeekResync;
  const invalidatePlaybackRun = controllerInvalidatePlaybackRun;
  const pauseActivePlayback = controllerPauseActivePlayback;
  const seekPlaybackTo = controllerSeekPlaybackTo;
  const seekPlaybackToOrdinal = controllerSeekPlaybackToOrdinal;
  const togglePlay = controllerTogglePlay;

  const clearPendingEpubJump = useCallback(() => {
    pendingEpubJumpRef.current = null;
    epubJumpEpochRef.current += 1;
  }, []);

  const {
    pause,
    prepareInitialPosition,
    setDocumentPlaybackAnchor,
    setText,
    skipBackward,
    skipForward,
    skipToLocation,
  } = useTtsDocumentNavigation({
    activeReaderType,
    currDocPage,
    currDocPageNumber,
    currentIndex,
    isEPUB,
    isPlaying,
    sentences,
    skipBlank,
    advanceRef,
    epubJumpEpochRef,
    isPlayingRef,
    locationChangeHandlerRef,
    pauseEpochRef,
    pendingEpubJumpRef,
    playbackActiveRef,
    playbackAnchorRef,
    playbackSegmentsRef,
    playbackSyncNavigationRef,
    resumeAfterLocationChangeRef,
    sentenceAlignmentCacheRef,
    abortAudio,
    cancelSeekResync,
    clearPendingEpubJump,
    clearPlaybackSegments,
    invalidatePlaybackRun,
    pauseActivePlayback,
    resetPlaybackPlan,
    seekPlaybackToOrdinal,
    selectPlaybackSegment,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    setCurrDocPage,
    setIsPlaying,
    setIsProcessing,
    setPlaybackAnchor,
  });

  const updateVoiceAndSpeed = useCallback(() => {
    setVoice(configVoice);
    setSpeed(voiceSpeed);
    setAudioSpeed(audioPlayerSpeed);
  }, [configVoice, voiceSpeed, audioPlayerSpeed]);

  /**
   * Initializes configuration and fetches available voices
   */
  useEffect(() => {
    if (!configIsLoading) {
      updateVoiceAndSpeed();
      setTTSModel(configTTSModel);
      setTTSInstructions(configTTSInstructions);
    }
  }, [configIsLoading, updateVoiceAndSpeed, configTTSModel, configTTSInstructions]);

  const preloadGenerationSignatureRef = useRef<string>('');
  useEffect(() => {
    const signature = [
      documentId,
      configProviderRef,
      ttsModel,
      voice,
      effectiveNativeSpeed,
      providerModelPolicy.supportsInstructions ? ttsInstructions : '',
      resolvedLanguage,
      ttsSegmentMaxBlockLength,
    ].join('|');

    if (!preloadGenerationSignatureRef.current) {
      preloadGenerationSignatureRef.current = signature;
      return;
    }
    if (preloadGenerationSignatureRef.current === signature) return;

    preloadGenerationSignatureRef.current = signature;
    clearPendingEpubJump();
  }, [
    documentId,
    configProviderRef,
    ttsModel,
    voice,
    effectiveNativeSpeed,
    providerModelPolicy.supportsInstructions,
    ttsInstructions,
    resolvedLanguage,
    ttsSegmentMaxBlockLength,
    clearPendingEpubJump,
  ]);

  /**
   * Validates that the current voice is in the available voices list
   * If voice is empty or invalid, use the first available voice (only in local state, don't save)
   */
  useEffect(() => {
    if (availableVoices.length > 0) {
      // Allow Kokoro multi-voice strings (e.g., "voice1(0.5)+voice2(0.5)") for any provider
      const isKokoro = configModelPolicy.isKokoroModel;
      const fallbackVoice = configVoice || availableVoices[0];
      const providerUnresolved = !configModelPolicy.isResolvedProviderType;

      if (isKokoro && providerUnresolved && voice.includes('+')) {
        const firstVoice = voice.split('+')[0]?.replace(/\([^)]*\)/g, '').trim();
        if (firstVoice) {
          setVoice(firstVoice);
        }
        return;
      }

      if (isKokoro) {
        // If Kokoro and we have any voice string (including plus/weights), don't override it.
        // Only default when local voice is empty.
        if (!voice) {
          setVoice(fallbackVoice);
        }
        return;
      }

      // For non-Kokoro, only force a fallback when there is no active local voice.
      // If a persisted config voice exists, keep it rather than overriding from a
      // potentially stale in-flight voices response during reload.
      if (!voice) {
        setVoice(fallbackVoice);
        return;
      }

      if (!configVoice && !availableVoices.includes(voice)) {
        setVoice(availableVoices[0]);
        // Don't save to config - just use it temporarily until user explicitly selects one
      }
    }
  }, [availableVoices, voice, configVoice, configModelPolicy]);

  useEffect(() => {
    if (unlockedAudioRef.current) {
      unlockedAudioRef.current.playbackRate = audioSpeed;
    }
  }, [audioSpeed, unlockedAudioRef]);

  /**
   * Stops the current audio playback and resets all state
   */
  const stop = useCallback(() => {
    // Cancel any ongoing request
    invalidatePlaybackRun();
    abortAudio();
    clearPendingEpubJump();
    setIsPlaying(false);
    publishPlaybackTimeSec(0, { force: true });
    resetPlaybackPlan();
    playbackAnchorRef.current = null;
    setPlaybackAnchor(null);
    setCurrDocPage(1);
    setCurrDocPages(undefined);
    setIsProcessing(false);
    setIsEPUB(false);
    sentenceAlignmentCacheRef.current.clear();
    setCurrentSentenceAlignment(undefined);
    setCurrentWordIndex(null);
  }, [abortAudio, invalidatePlaybackRun, clearPendingEpubJump, publishPlaybackTimeSec, resetPlaybackPlan]);

  const {
    clearSegmentCaches,
    invalidatePlaybackPlan,
    setAudioPlayerSpeedAndRestart,
    setSpeedAndRestart,
    setVoiceAndRestart,
  } = useTtsPlaybackSettings({
    isPlaying,
    restartSeqRef,
    sentenceAlignmentCacheRef,
    abortAudio,
    clearPendingEpubJump,
    resetPlaybackPlan,
    setAudioSpeed,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    setIsPlaying,
    setIsProcessing,
    setSpeed,
    setVoice,
    updateConfigKey,
  });


  /**
   * Provides the TTS context value to child components
   */
  const value = useMemo(() => ({
    isPlaying,
    isProcessing,
    currentSentence,
    currentSegment,
    sentences,
    currentSentenceOrdinal: selectedOrdinal,
    playbackTimeSec,
    playbackDurationSec: playbackSeekLayout ? playbackSeekLayout.durationMs / 1000 : 0,
    playbackSeekLayout,
    resolveDocumentAudioExport,
    startDocumentAudioExport,
    currentSentenceAlignment,
    currentWordIndex,
    currDocPage,
    currDocPageNumber,
    currDocPages,
    voice,
    availableVoices,
    togglePlay,
    skipForward,
    skipBackward,
    stop,
    pause,
    seekPlaybackTo,
    setText,
    setDocumentPlaybackAnchor,
    setCurrDocPages,
    setSpeedAndRestart,
    setAudioPlayerSpeedAndRestart,
    setVoiceAndRestart,
    invalidatePlaybackPlan,
    setPdfSkipBlockKinds,
    documentLanguage,
    resolvedLanguage,
    setDocumentLanguage,
    clearSegmentCaches,
    skipToLocation,
    prepareInitialPosition,
    registerLocationChangeHandler,
    setIsEPUB,
    activeReaderType,
  }), [
    isPlaying,
    isProcessing,
    currentSentence,
    currentSegment,
    sentences,
    playbackSeekLayout,
    playbackTimeSec,
    resolveDocumentAudioExport,
    startDocumentAudioExport,
    selectedOrdinal,
    currDocPage,
    currDocPageNumber,
    currDocPages,
    voice,
    availableVoices,
    togglePlay,
    skipForward,
    skipBackward,
    stop,
    pause,
    seekPlaybackTo,
    setText,
    setDocumentPlaybackAnchor,
    setCurrDocPages,
    setSpeedAndRestart,
    setAudioPlayerSpeedAndRestart,
    setVoiceAndRestart,
    invalidatePlaybackPlan,
    setPdfSkipBlockKinds,
    documentLanguage,
    resolvedLanguage,
    clearSegmentCaches,
    skipToLocation,
    prepareInitialPosition,
    registerLocationChangeHandler,
    setIsEPUB,
    currentSentenceAlignment,
    currentWordIndex,
    activeReaderType,
  ]);

  // Use media session hook
  useMediaSession({
    togglePlay,
    skipForward,
    skipBackward,
  });

  /**
   * Renders the TTS context provider with its children
   * 
   * @param {ReactNode} children - Child components to be wrapped
   * @returns {JSX.Element}
   */
  return (
    <TTSContext.Provider value={value}>
      {children}
    </TTSContext.Provider>
  );
}

/**
 * Custom hook to consume the TTS context
 * Ensures the context is used within a TTSProvider
 * 
 * @throws {Error} If used outside of TTSProvider
 * @returns {TTSContextType} The TTS context value
 */
export function useTTS() {
  const context = useContext(TTSContext);
  if (context === undefined) {
    throw new Error('useTTS must be used within a TTSProvider');
  }
  return context;
}

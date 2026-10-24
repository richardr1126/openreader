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
import type { SpeechTextOptions } from '@openreader/tts/speech-text';

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
import { useQueryClient } from '@tanstack/react-query';

import { useConfig } from '@/contexts/ConfigContext';
import { useVoiceManagement } from '@/hooks/audio/useVoiceManagement';
import { useDefaultVoice } from '@/hooks/audio/useDefaultVoice';
import { useAudioContext } from '@/hooks/audio/useAudioContext';
import { useTtsPlayback, type TtsPlaybackPlanRequest } from '@/hooks/audio/useTtsPlayback';
import {
  useTtsDocumentNavigation,
  type EpubRenderedAnchorInput,
  type EpubRenderedAnchorResult,
  type EpubPlanLocatorResult,
} from '@/hooks/audio/useTtsDocumentNavigation';
import { useTtsDocumentExport, type TtsDocumentAudioExportRequest } from '@/hooks/audio/useTtsDocumentExport';
import type { TtsExportResolveSnapshot } from '@/types/tts-export';
import { useTtsPlanController } from '@/hooks/audio/useTtsPlanController';
import { useTtsPlaybackModel } from '@/hooks/audio/useTtsPlaybackModel';
import { useTtsPlaybackSettings } from '@/hooks/audio/useTtsPlaybackSettings';
import type { TtsPlaybackPlanPayload, TtsPlaybackSeekLayout } from '@/lib/client/api/tts';
import { isPlaybackPhaseProcessing } from '@/lib/client/tts/playback-control';
import {
  pdfLocatorPage,
  resolveDocumentAnchorSelectionOrdinal,
  type PlaybackAnchor,
} from '@/lib/client/tts/playback-selection';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import { DEFAULT_TTS_LANGUAGE } from '@openreader/tts/language';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import type {
  TTSLocation,
  TTSPlaybackState,
  TTSSentenceAlignment,
  TtsPlaybackPhase,
} from '@/types/tts';
import type { TTSSegmentLocator } from '@/types/client';
import type { DocumentSettings } from '@/types/document-settings';
import type { ReaderPlaybackPreparation } from '@/types/reader-bootstrap';
import { resolveBookVoice } from '@/lib/shared/document-settings';

import type { ReaderType } from '@/types/user-state';
import { playbackPlanIdentity, type TtsPlaybackPlan } from '@/lib/shared/playback-plan';
import { resolveReadingPositionOrdinal, type ReadingPosition } from '@/lib/shared/reading-position';
import { queryKeys } from '@/lib/client/query-keys';
import type { EpubLocationChangeIntent } from '@/lib/client/epub/location-controller';

type EpubLocationChangeHandler = (
  location: TTSLocation | TTSSegmentLocator,
  intent?: EpubLocationChangeIntent,
) => void;

/**
 * Interface defining all available methods and properties in the TTS context
 */
interface TTSContextType extends Omit<TTSPlaybackState, 'currentSentence' | 'currentSegment'> {
  /** The open book's voice and model speed: its own picks, else the defaults. */
  voice: string;
  voiceSpeed: number;
  /** Whether the open book overrides the default voice / model speed. */
  ownVoice: boolean;
  ownVoiceSpeed: boolean;
  availableVoices: string[];

  // Current playback plan text and cursor
  sentences: string[];
  currentSentenceOrdinal: number | null;
  playbackPhase: TtsPlaybackPhase;
  audioSpeed: number;
  playbackPlanSegmentCount: number | null;
  resolveDocumentAudioExport: (options: TtsDocumentAudioExportRequest, signal?: AbortSignal) => Promise<TtsExportResolveSnapshot>;

  // Control functions
  followingNarration: boolean;
  setFollowingNarration: (enabled: boolean) => void;
  returnToNarration: () => void;
  readerNavigationRevision: number;
  browseToLocation: (location: TTSLocation) => void;
  togglePlay: () => void;
  skipForward: () => void;
  skipBackward: () => void;
  pause: () => void;
  stop: () => void;
  seekPlaybackTo: (seconds: number) => void;
  reconcileEpubRenderedAnchor: (rendered: EpubRenderedAnchorInput) => EpubRenderedAnchorResult;
  resolveEpubPlanLocator: (savedLocator: TTSSegmentLocator | null) => EpubPlanLocatorResult;
  setDocumentPlaybackAnchor: (location: TTSLocation, hasReadableText: boolean, locator?: TTSSegmentLocator | null) => void;
  setCurrDocPages: (num: number | undefined) => void;
  setAudioPlayerSpeedAndRestart: (speed: number) => void;
  /** Set (or with null, reset) the open book's voice and/or model speed with one plan restart. */
  setBookVoiceAndRestart: (change: { voice?: string | null; nativeSpeed?: number | null }) => void;
  bookSpeechText: Partial<SpeechTextOptions>;
  setBookSpeechText: (value: Partial<SpeechTextOptions>) => void;
  /** Reacquire the server-owned bootstrap payload after plan-affecting settings change. */
  reacquirePlaybackPlan: () => Promise<void>;
  initializeReaderSession: (input: {
    readerType: ReaderType;
    documentLanguage: string | null;
    settings: DocumentSettings;
    plan: TtsPlaybackPlan;
    playback: ReaderPlaybackPreparation;
    initialPosition: ReadingPosition | null;
  }) => void;
  /**
   * Swap in a plan the server re-planned for the open reader (voice, speed,
   * language, segmentation) without resetting the reading position.
   */
  adoptReplannedPlaybackPlan: (input: { settings: DocumentSettings; plan: TtsPlaybackPlan; playback: ReaderPlaybackPreparation; documentLanguage: string | null }) => void;
  playbackPlanReady: boolean;
  /** Identity of the adopted plan, or null while none is adopted. */
  playbackPlanKey: string | null;
  documentLanguage: string;
  detectedDocumentLanguage: string | null;
  resolvedLanguage: string;
  clearSegmentCaches: () => void;
  /** Settings payload that identifies the document's current audio cache. */
  playbackPlanPayload: TtsPlaybackPlanPayload | null;
  /** Seek to a plan ordinal through the sentence-skip path; false if not in the plan. */
  skipToOrdinal: (ordinal: number) => boolean;
  playbackSegments: CanonicalTtsSegment[];
  registerLocationChangeHandler: (handler: EpubLocationChangeHandler | null) => void;  // EPUB-only: Handles chapter navigation
  setIsEPUB: (isEPUB: boolean) => void;
  /** Effective reader type used for worker playback/session scoping. */
  activeReaderType: ReaderType;
}

type TTSPlaybackProgressContextType = {
  playbackTimeSec: number;
  playbackDurationSec: number;
  playbackSeekLayout: TtsPlaybackSeekLayout | null;
  modelDownload: ReturnType<typeof useTtsPlayback>['modelDownload'];
};

type TTSHighlightContextType = {
  currentSentence: string;
  currentSegment?: CanonicalTtsSegment | null;
  currentSentenceAlignment?: TTSSentenceAlignment;
  currentWordIndex?: number | null;
};

// Create the context
const TTSContext = createContext<TTSContextType | undefined>(undefined);
const TTSPlaybackProgressContext = createContext<TTSPlaybackProgressContextType | undefined>(undefined);
const TTSHighlightContext = createContext<TTSHighlightContextType | undefined>(undefined);

/**
 * Main provider component that manages the TTS state and functionality.
 * Handles initialization of audio context, media session, and playback.
 * 
 * @param {Object} props - Component props
 * @param {ReactNode} props.children - Child components to be wrapped by the provider
 * @returns {JSX.Element} TTSProvider component
 */
export function TTSProvider({ children }: { children: ReactNode }): ReactElement {
  const queryClient = useQueryClient();
  // Configuration context consumption
  const {
    isLoading: configIsLoading,
    voiceSpeed,
    audioPlayerSpeed,
    voice: configVoice,
    providerRef: configProviderRef,
    providerType: configProviderType,
    ttsModel: configTTSModel,
    updateConfigKey,
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
  const locationChangeHandlerRef = useRef<EpubLocationChangeHandler | null>(null);

  /**
   * Registers a handler function for location changes in EPUB documents
   * This is only used for EPUB documents to handle chapter navigation
   *
   * @param {Function} handler - Function to handle location changes
   */
  const registerLocationChangeHandler = useCallback((handler: EpubLocationChangeHandler | null) => {
    locationChangeHandlerRef.current = handler;
  }, []);

  /**
   * State Management
   */
  const [isPlaying, setIsPlaying] = useState(false);
  const [isEPUB, setIsEPUB] = useState(false);
  const [isInteractionProcessing, setIsProcessing] = useState(false);

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
    playbackSegments,
    sentences,
    currentIndex,
    currentSentence,
    currentSegment,
    selectedOrdinal,
    playbackPlan,
    playbackSeekLayout,
    applyWorkerPlan,
    resetPlaybackPlan,
    setSelectedOrdinal,
    setPlaybackSeekLayout,
  } = useTtsPlaybackModel();
  const { voice, speed } = useDefaultVoice({
    configIsLoading,
    configVoice,
    voiceSpeed,
    availableVoices,
    providerRef: configProviderRef,
    providerType: configProviderType,
    ttsModel: configTTSModel,
  });
  const [audioSpeed, setAudioSpeed] = useState(audioPlayerSpeed);
  const ttsModel = configTTSModel;
  const [playbackPlanRequest, setPlaybackPlanRequest] = useState<TtsPlaybackPlanRequest | null>(null);
  const [readerSettings, setReaderSettings] = useState<DocumentSettings | null>(null);
  const [detectedDocumentLanguage, setDetectedDocumentLanguage] = useState<string | null>(null);
  const documentLanguage = readerSettings?.language ?? 'auto';
  const bookVoice = resolveBookVoice({
    override: readerSettings?.voiceOverride,
    providerRef: configProviderRef,
    ttsModel,
    defaultVoice: voice,
    defaultVoiceSpeed: speed,
  });
  const resolvedLanguage = playbackPlanRequest?.payload.settings.language ?? DEFAULT_TTS_LANGUAGE;

  const playbackRunIdRef = useRef(0);
  // Guard to coalesce rapid restarts and only resume the latest change
  const restartSeqRef = useRef(0);
  const sentenceAlignmentCacheRef = useRef<Map<string, TTSSentenceAlignment>>(new Map());
  const [currentSentenceAlignment, setCurrentSentenceAlignment] = useState<TTSSentenceAlignment | undefined>();
  const [currentWordIndex, setCurrentWordIndex] = useState<number | null>(null);
  const isPlayingRef = useRef(false);
  const pauseEpochRef = useRef(0);
  const playbackAnchorRef = useRef<PlaybackAnchor | null>(null);
  const [, setPlaybackAnchor] = useState<PlaybackAnchor | null>(null);
  const [followingNarration, setFollowing] = useState(true);
  const followingNarrationRef = useRef(true);
  const [readerNavigationRevision, setReaderNavigationRevision] = useState(0);
  // The single "make the view follow the cursor" primitive. Used identically by
  // live playback (projection), the scrubber, and skip — so paused skip turns the
  // page exactly like playback. It does NOT depend on playback being active.
  const syncPlaybackLocator = useCallback((locator: TTSSegmentLocator | null) => {
    if (!locator || !followingNarrationRef.current) return;
    const page = pdfLocatorPage(locator);
    if (page !== null) {
      setCurrDocPage(page);
      return;
    }
    if (locator.readerType === 'epub') {
      const handler = locationChangeHandlerRef.current;
      if (!handler) return;
      handler(locator, 'playback-follow');
    }
  }, []);

  // These commands move only the renderer. They never seek, write progress,
  // or touch the canonical audio session and its generation window.
  const returnToNarration = useCallback(() => {
    followingNarrationRef.current = true;
    setFollowing(true);
    const segment = playbackSegmentsRef.current.find((entry) => entry.ordinal === selectedOrdinalRef.current);
    syncPlaybackLocator(segment?.ownerLocator ?? null);
    setReaderNavigationRevision((revision) => revision + 1);
  }, [playbackSegmentsRef, selectedOrdinalRef, syncPlaybackLocator]);
  const setFollowingNarration = useCallback((enabled: boolean) => {
    if (enabled) returnToNarration();
    else {
      followingNarrationRef.current = false;
      setFollowing(false);
    }
  }, [returnToNarration]);
  const browseToLocation = useCallback((location: TTSLocation) => {
    setFollowingNarration(false);
    setCurrDocPage(location);
  }, [setFollowingNarration]);

  const selectPlaybackSegment = useCallback((segment: CanonicalTtsSegment | null | undefined): boolean => {
    const ordinal = Number(segment?.ordinal);
    if (!Number.isFinite(ordinal)) return false;
    setSelectedOrdinal(Math.max(0, Math.floor(ordinal)));
    return true;
  }, [setSelectedOrdinal]);

  const advanceRef = useRef<((backwards?: boolean) => void | Promise<void>) | null>(null);
  const {
    acceptBootstrapPlaybackPlan,
    applyPlaybackPlan,
    buildPlaybackPlanRequest,
    buildPlaybackSessionRequest,
    getPlaybackPlan,
  } = useTtsPlanController({
    activeReaderType,
    currentLocation: currDocPage,
    currentPdfPage: currDocPageNumber,
    playbackAnchorRef,
    playbackPlanRef,
    request: playbackPlanRequest,
    selectedOrdinalRef,
    applyWorkerPlan,
    setPlaybackSeekLayout,
    setSelectedOrdinal,
  });
  const { resolveDocumentAudioExport } = useTtsDocumentExport({
    playbackPlanRef,
    applyWorkerPlan,
    buildPlaybackPlanRequest,
  });
  const playbackController = useMemo(() => ({
    applyPlaybackPlan,
    buildPlaybackPlanRequest,
    buildPlaybackSessionRequest,
    getPlaybackPlan,
  }), [
    applyPlaybackPlan,
    buildPlaybackPlanRequest,
    buildPlaybackSessionRequest,
    getPlaybackPlan,
  ]);

  const {
    playbackPhase,
    playbackTimeSec, modelDownload,
    abortAudio: controllerAbortAudio,
    cancelPendingSeek: controllerCancelPendingSeek,
    pauseActivePlayback: controllerPauseActivePlayback,
    seekPlaybackTo: controllerSeekPlaybackTo,
    seekPlaybackToOrdinal: controllerSeekPlaybackToOrdinal,
    syncActivePlaybackToOrdinal,
    togglePlay: controllerTogglePlay,
  } = useTtsPlayback({
    audioContext: audioContext ?? null,
    audioSpeed,
    canStartPlayback: isPlaying && (Boolean(sentences[currentIndex]) || Boolean(playbackAnchorRef.current?.hasContent || playbackAnchorRef.current?.text.trim())),
    isPlaying,
    isPlayingRef,
    playbackSegmentsRef,
    playbackSeekLayout,
    selectedOrdinal,
    selectedOrdinalRef,
    playbackRunIdRef,
    setIsPlaying,
    syncPlaybackLocator,
    setSelectedOrdinal,
    setPlaybackSeekLayout,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    onAdvance: () => advanceRef.current?.(),
    controller: playbackController,
  });

  const abortAudio = controllerAbortAudio;
  const cancelPendingSeek = controllerCancelPendingSeek;
  const pauseActivePlayback = controllerPauseActivePlayback;
  const seekPlaybackTo = useCallback((seconds: number) => {
    followingNarrationRef.current = true;
    setFollowing(true);
    controllerSeekPlaybackTo(seconds);
  }, [controllerSeekPlaybackTo]);
  const seekPlaybackToOrdinal = useCallback((ordinal: number) => {
    followingNarrationRef.current = true;
    setFollowing(true);
    return controllerSeekPlaybackToOrdinal(ordinal);
  }, [controllerSeekPlaybackToOrdinal]);
  const togglePlay = controllerTogglePlay;

  const {
    pause,
    reconcileEpubRenderedAnchor,
    resolveEpubPlanLocator,
    setDocumentPlaybackAnchor,
    skipBackward,
    skipForward,
    skipToOrdinal,
  } = useTtsDocumentNavigation({
    activeReaderType,
    isPlaying,
    sentences,
    advanceRef,
    isPlayingRef,
    pauseEpochRef,
    playbackAnchorRef,
    playbackPlanReady: Boolean(playbackPlan?.planObjectKey),
    playbackPlanRef,
    playbackSegmentsRef,
    selectedOrdinalRef,
    cancelPendingSeek,
    pauseActivePlayback,
    seekPlaybackToOrdinal,
    syncActivePlaybackToOrdinal,
    selectPlaybackSegment,
    setCurrDocPage,
    setIsPlaying,
    setIsProcessing,
    setPlaybackAnchor,
    setSelectedOrdinal,
    syncPlaybackLocator,
  });

  useEffect(() => {
    if (configIsLoading) return;
    setAudioSpeed(audioPlayerSpeed);
  }, [configIsLoading, audioPlayerSpeed]);

  /**
   * Stops the current audio playback and resets all state
   */
  const stop = useCallback(() => {
    followingNarrationRef.current = true;
    setFollowing(true);
    abortAudio();
    setIsPlaying(false);
    resetPlaybackPlan();
    setPlaybackPlanRequest(null);
    setDetectedDocumentLanguage(null);
    playbackAnchorRef.current = null;
    setPlaybackAnchor(null);
    setCurrDocPage(1);
    setCurrDocPages(undefined);
    setIsProcessing(false);
    setIsEPUB(false);
    sentenceAlignmentCacheRef.current.clear();
    setCurrentSentenceAlignment(undefined);
    setCurrentWordIndex(null);
  }, [abortAudio, resetPlaybackPlan]);

  const initializeReaderSession = useCallback((input: {
    readerType: ReaderType;
    documentLanguage: string | null;
    settings: DocumentSettings;
    plan: TtsPlaybackPlan;
    playback: ReaderPlaybackPreparation;
    initialPosition: ReadingPosition | null;
  }) => {
    stop();
    setReaderSettings(input.settings);
    setDetectedDocumentLanguage(input.documentLanguage);
    setIsEPUB(input.readerType === 'epub');
    setPlaybackPlanRequest({
      headers: { 'Content-Type': 'application/json', 'x-tts-provider': input.playback.request.settings.providerRef },
      payload: input.playback.request,
    });
    acceptBootstrapPlaybackPlan(input.plan, input.playback.seekLayout);

    if (input.readerType === 'epub') {
      // EPUB establishes its cursor only after the saved segment's location
      // has committed in the rendition (useEpubDocument).
      setSelectedOrdinal(null);
      return;
    }

    // The saved cursor resolves against the plan; the page is derived from the
    // resolved segment. HTML is one scrolling surface, so its anchor is '1'.
    const plan = playbackSegmentsRef.current;
    const savedOrdinal = resolveReadingPositionOrdinal(plan, input.initialPosition);
    const savedSegment = savedOrdinal === null
      ? null
      : plan.find((segment) => segment.ordinal === savedOrdinal) ?? null;
    const location = input.readerType === 'pdf'
      ? pdfLocatorPage(savedSegment?.ownerLocator) ?? 1
      : 1;
    setCurrDocPage(location);
    setSelectedOrdinal(resolveDocumentAnchorSelectionOrdinal({
      plan,
      readerType: input.readerType,
      location,
      selectedOrdinal: savedOrdinal,
    }));
  }, [
    acceptBootstrapPlaybackPlan,
    playbackSegmentsRef,
    setSelectedOrdinal,
    stop,
  ]);

  const adoptReplannedPlaybackPlan = useCallback((input: {
    settings: DocumentSettings;
    documentLanguage: string | null;
    plan: TtsPlaybackPlan;
    playback: ReaderPlaybackPreparation;
  }) => {
    abortAudio();
    setIsPlaying(false);
    setReaderSettings(input.settings);
    setDetectedDocumentLanguage(input.documentLanguage);
    setPlaybackPlanRequest({
      headers: { 'Content-Type': 'application/json', 'x-tts-provider': input.playback.request.settings.providerRef },
      payload: input.playback.request,
    });
    acceptBootstrapPlaybackPlan(input.plan, input.playback.seekLayout);
  }, [abortAudio, acceptBootstrapPlaybackPlan]);

  const reacquirePlaybackPlan = useCallback(async () => {
    if (!documentId) return;
    await queryClient.refetchQueries({
      queryKey: queryKeys.readerBootstraps(),
      type: 'active',
    });
  }, [documentId, queryClient]);

  const {
    clearSegmentCaches,
    setAudioPlayerSpeedAndRestart,
    setBookVoiceAndRestart,
    setBookSpeechText,
  } = useTtsPlaybackSettings({
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
    providerRef: configProviderRef,
    ttsModel,
    defaultVoice: voice,
    defaultVoiceSpeed: speed,
    updateConfigKey,
    reacquirePlaybackPlan,
  });

  const isProcessing = isInteractionProcessing
    || isPlaybackPhaseProcessing(isPlaying, playbackPhase);
  const canSkip = !isInteractionProcessing && Boolean(playbackPlan?.planObjectKey);

  /**
   * Provides the TTS context value to child components
   */
  const value = useMemo(() => ({
    followingNarration, setFollowingNarration, returnToNarration, readerNavigationRevision, browseToLocation,
    isPlaying,
    isProcessing,
    canSkip,
    sentences,
    currentSentenceOrdinal: selectedOrdinal,
    playbackPhase,
    audioSpeed,
    playbackPlanSegmentCount: playbackPlan ? sentences.length : null,
    resolveDocumentAudioExport,
    currDocPage,
    currDocPageNumber,
    currDocPages,
    voice: bookVoice.voice,
    voiceSpeed: bookVoice.voiceSpeed,
    ownVoice: bookVoice.ownVoice,
    ownVoiceSpeed: bookVoice.ownVoiceSpeed,
    availableVoices,
    togglePlay,
    skipForward,
    skipBackward,
    stop,
    pause,
    seekPlaybackTo,
    reconcileEpubRenderedAnchor,
    resolveEpubPlanLocator,
    setDocumentPlaybackAnchor,
    setCurrDocPages,
    setAudioPlayerSpeedAndRestart,
    setBookVoiceAndRestart,
    bookSpeechText: readerSettings?.speechText ?? {},
    setBookSpeechText,
    reacquirePlaybackPlan,
    initializeReaderSession,
    adoptReplannedPlaybackPlan,
    playbackPlanReady: Boolean(playbackPlan?.planObjectKey),
    playbackPlanKey: playbackPlan?.planObjectKey
      ? playbackPlanIdentity(playbackPlan)
      : null,
    documentLanguage,
    detectedDocumentLanguage,
    resolvedLanguage,
    clearSegmentCaches,
    playbackPlanPayload: playbackPlanRequest?.payload ?? null,
    skipToOrdinal, playbackSegments,
    registerLocationChangeHandler,
    setIsEPUB,
    activeReaderType,
  }), [
    followingNarration, setFollowingNarration, returnToNarration, readerNavigationRevision, browseToLocation,
    isPlaying,
    isProcessing,
    canSkip,
    sentences,
    playbackPlan,
    resolveDocumentAudioExport,
    selectedOrdinal,
    playbackPhase,
    audioSpeed,
    currDocPage,
    currDocPageNumber,
    currDocPages,
    bookVoice.voice,
    bookVoice.voiceSpeed,
    bookVoice.ownVoice,
    bookVoice.ownVoiceSpeed,
    availableVoices,
    togglePlay,
    skipForward,
    skipBackward,
    stop,
    pause,
    seekPlaybackTo,
    reconcileEpubRenderedAnchor,
    resolveEpubPlanLocator,
    setDocumentPlaybackAnchor,
    setCurrDocPages,
    setAudioPlayerSpeedAndRestart,
    setBookVoiceAndRestart,
    readerSettings?.speechText,
    setBookSpeechText,
    reacquirePlaybackPlan,
    initializeReaderSession,
    adoptReplannedPlaybackPlan,
    documentLanguage,
    detectedDocumentLanguage,
    resolvedLanguage,
    clearSegmentCaches,
    playbackPlanRequest,
    skipToOrdinal, playbackSegments,
    registerLocationChangeHandler,
    setIsEPUB,
    activeReaderType,
  ]);
  const playbackProgressValue = useMemo(() => ({
    playbackTimeSec,
    playbackDurationSec: playbackSeekLayout ? playbackSeekLayout.durationMs / 1000 : 0,
    playbackSeekLayout, modelDownload,
  }), [modelDownload, playbackSeekLayout, playbackTimeSec]);
  const highlightValue = useMemo(() => ({
    currentSentence,
    currentSegment,
    currentSentenceAlignment,
    currentWordIndex,
  }), [currentSentence, currentSegment, currentSentenceAlignment, currentWordIndex]);

  /**
   * Renders the TTS context provider with its children
   * 
   * @param {ReactNode} children - Child components to be wrapped
   * @returns {JSX.Element}
   */
  return (
    <TTSContext.Provider value={value}>
      <TTSPlaybackProgressContext.Provider value={playbackProgressValue}>
        <TTSHighlightContext.Provider value={highlightValue}>
          {children}
        </TTSHighlightContext.Provider>
      </TTSPlaybackProgressContext.Provider>
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

/** High-frequency media-clock and generated-track state, consumed only by the player. */
export function useTTSPlaybackProgress() {
  const context = useContext(TTSPlaybackProgressContext);
  if (context === undefined) {
    throw new Error('useTTSPlaybackProgress must be used within a TTSProvider');
  }
  return context;
}

/** Audio-clock projection consumed only by the mounted document surface. */
export function useTTSHighlight() {
  const context = useContext(TTSHighlightContext);
  if (context === undefined) {
    throw new Error('useTTSHighlight must be used within a TTSProvider');
  }
  return context;
}

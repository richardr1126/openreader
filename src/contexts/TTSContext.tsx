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
import toast from 'react-hot-toast';
import { useParams, usePathname } from 'next/navigation';

import { useConfig } from '@/contexts/ConfigContext';
import { useVoiceManagement } from '@/hooks/audio/useVoiceManagement';
import { useMediaSession } from '@/hooks/audio/useMediaSession';
import { useAudioContext } from '@/hooks/audio/useAudioContext';
import { useTtsPlayback } from '@/hooks/audio/useTtsPlayback';
import { useTtsPlaybackModel } from '@/hooks/audio/useTtsPlaybackModel';
import {
  createTtsPlaybackSession,
  createTtsPlaybackPlan,
  getTtsPlaybackSeekLayout,
  resolveTtsExport,
  type TtsPlaybackPlanPayload,
  type TtsPlaybackSeekLayout,
} from '@/lib/client/api/tts';
import {
  normalizePlaybackPlan,
} from '@/lib/client/tts/playback-plan';
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
import { isPdfLocator, isStableEpubLocator } from '@/types/client';
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

  // Sentence/segment list and cursor (for the segments sidebar)
  sentences: string[];
  playbackSegments: CanonicalTtsSegment[];
  playbackPlanSource: 'idle' | 'worker';
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
  stopAndPlayFromOrdinal: (ordinal: number) => void;
  playFromOrdinal: (ordinal: number, locator?: TTSSegmentLocator | null) => void;
  seekPlaybackTo: (seconds: number) => void;
  setText: (text: string, options?: boolean | SetTextOptions) => void;
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

type TtsDocumentAudioExportResolution = {
  sessionId: string;
  artifactId: string;
  downloadUrl: string | null;
  generationOperationId: string | null;
  artifactOperationId: string | null;
  generationStatus: string | null;
  artifactStatus: string | null;
  seekLayoutUrl: string;
  plannedCount: number;
  completedCount: number | null;
};

interface SetTextOptions {
  shouldPause?: boolean;
  location?: TTSLocation;
  /**
   * Stable locator for the visible start position. Load-bearing for EPUB worker
   * playback: startup anchors by spine coordinates because the worker plan is
   * keyed from persisted document structure, not transient viewport state.
   */
  startLocator?: TTSSegmentLocator;
}

type PlaybackAnchor = {
  text: string;
  location: TTSLocation;
  locator: TTSSegmentLocator | null;
  hasContent: boolean;
};

type PlaybackStartLocation = {
  page?: TTSLocation;
  spineIndex?: number;
  charOffset?: number;
};
const pdfLocatorPage = (locator: TTSSegmentLocator | null | undefined): number | null => {
  return isPdfLocator(locator) ? Math.max(1, Math.floor(locator.page)) : null;
};

const pdfAnchorPage = (location: TTSLocation | undefined): number | null => {
  return typeof location === 'number' && Number.isFinite(location)
    ? Math.max(1, Math.floor(location))
    : null;
};

const resolveFirstPlanIndexForPdfPage = (
  plan: CanonicalTtsSegment[],
  page: number | undefined,
): number => {
  if (typeof page !== 'number' || !Number.isFinite(page)) return -1;
  const targetPage = Math.max(1, Math.floor(page));
  return plan.findIndex((segment) => {
    return pdfLocatorPage(segment.ownerLocator) === targetPage;
  });
};

const resolveFirstPlanIndexForDocumentAnchor = (
  plan: CanonicalTtsSegment[],
  readerType: ReaderType,
  location: TTSLocation,
): number => {
  if (readerType === 'pdf') {
    const page = pdfAnchorPage(location);
    return page === null ? -1 : resolveFirstPlanIndexForPdfPage(plan, page);
  }
  if (readerType === 'html') {
    const locationKey = String(location || '1');
    return plan.findIndex((segment) => {
      const locator = segment.ownerLocator;
      return locator?.readerType === 'html' && String(locator.location || '1') === locationKey;
    });
  }
  return -1;
};

const resolvePlanBackedSelectionIndex = (input: {
  plan: CanonicalTtsSegment[];
  readerType: ReaderType;
  selectedOrdinal?: number | null;
  anchorLocation: PlaybackStartLocation;
}): number => {
  if (input.plan.length === 0) return -1;
  if (typeof input.selectedOrdinal === 'number' && Number.isFinite(input.selectedOrdinal)) {
    const byOrdinal = input.plan.findIndex((segment) => segment.ordinal === Math.max(0, Math.floor(input.selectedOrdinal!)));
    return byOrdinal;
  }

  if (input.readerType === 'pdf') {
    const page = typeof input.anchorLocation.page === 'number' ? input.anchorLocation.page : undefined;
    return resolveFirstPlanIndexForPdfPage(input.plan, page);
  }

  if (input.readerType === 'html') {
    const locationKey = String(input.anchorLocation.page ?? '1');
    return input.plan.findIndex((segment) => {
      const locator = segment.ownerLocator;
      return locator?.readerType === 'html' && String(locator.location || '1') === locationKey;
    });
  }

  if (input.readerType === 'epub') {
    if (
      typeof input.anchorLocation.spineIndex !== 'number'
      || typeof input.anchorLocation.charOffset !== 'number'
    ) {
      return -1;
    }
    return input.plan.findIndex((segment) => {
      const locator = segment.ownerLocator;
      if (locator?.readerType !== 'epub' || typeof locator.spineIndex !== 'number') return false;
      if (locator.spineIndex > input.anchorLocation.spineIndex!) return true;
      if (locator.spineIndex < input.anchorLocation.spineIndex!) return false;
      return typeof locator.charOffset !== 'number'
        || locator.charOffset >= input.anchorLocation.charOffset!;
    });
  }

  return -1;
};


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
    playbackSegments,
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
  const planPreviewRunIdRef = useRef(0);
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
  const buildPlaybackPlanRequestRef = useRef<(() => import('@/hooks/audio/useTtsPlayback').TtsPlaybackPlanRequest | null) | null>(null);
  const buildPlaybackSessionRequestRef = useRef<(() => import('@/hooks/audio/useTtsPlayback').TtsPlaybackSessionRequest | null) | null>(null);
  const createAndApplyPlaybackPlanRef = useRef<((request: import('@/hooks/audio/useTtsPlayback').TtsPlaybackPlanRequest, signal?: AbortSignal) => Promise<ReturnType<typeof normalizePlaybackPlan> | null>) | null>(null);
  const applyPlaybackPlanRef = useRef<((plan: ReturnType<typeof normalizePlaybackPlan>) => ReturnType<typeof normalizePlaybackPlan>) | null>(null);

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
    unlockPlaybackOnUserGesture: controllerUnlockPlaybackOnUserGesture,
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
    controllerRefs: {
      buildPlaybackPlanRequestRef,
      buildPlaybackSessionRequestRef,
      createAndApplyPlaybackPlanRef,
      applyPlaybackPlanRef,
    },
  });

  const abortAudio = controllerAbortAudio;
  const cancelSeekResync = controllerCancelSeekResync;
  const invalidatePlaybackRun = controllerInvalidatePlaybackRun;
  const pauseActivePlayback = controllerPauseActivePlayback;
  const seekPlaybackTo = controllerSeekPlaybackTo;
  const seekPlaybackToOrdinal = controllerSeekPlaybackToOrdinal;
  const unlockPlaybackOnUserGesture = controllerUnlockPlaybackOnUserGesture;
  const togglePlay = controllerTogglePlay;

  const clearPendingEpubJump = useCallback(() => {
    pendingEpubJumpRef.current = null;
    epubJumpEpochRef.current += 1;
  }, []);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const recordManualPause = useCallback(() => {
    // Cancel any queued auto-resume intent and mark an explicit user pause.
    resumeAfterLocationChangeRef.current = false;
    pauseEpochRef.current += 1;
  }, []);

  /**
   * Pauses the current audio playback
   * Used for external control of playback state
   */
  const pause = useCallback(() => {
    recordManualPause();
    clearPendingEpubJump();
    cancelSeekResync();
    pauseActivePlayback();
    setIsPlaying(false);
  }, [cancelSeekResync, pauseActivePlayback, recordManualPause, clearPendingEpubJump]);

  /**
   * Navigates to a specific location in the document
   * Works for both PDF pages and EPUB locations
   * 
   * @param {string | number} location - The target location to navigate to
   * @param {boolean} shouldPause - Whether to pause playback
   */
  const skipToLocation = useCallback((location: TTSLocation, shouldPause = false) => {
    // Cursor-follow echo (set by syncPlaybackLocator): keep the plan, just record
    // the position. Independent of play state so paused skip is swallowed too.
    if (playbackSyncNavigationRef.current) {
      if (activeReaderType === 'pdf' || activeReaderType === 'html') {
        playbackSyncNavigationRef.current = false;
      } else {
        setCurrDocPage(location);
        return;
      }
    }

    if (activeReaderType === 'pdf' || activeReaderType === 'html') {
      setCurrDocPage(location);
      if (shouldPause) {
        resumeAfterLocationChangeRef.current = false;
        pauseActivePlayback();
        setIsPlaying(false);
      } else if (isPlayingRef.current) {
        resumeAfterLocationChangeRef.current = true;
      }
      const planIndex = resolveFirstPlanIndexForDocumentAnchor(
        playbackSegmentsRef.current,
        activeReaderType,
        location,
      );
      if (planIndex >= 0) {
        selectPlaybackSegment(playbackSegmentsRef.current[planIndex]);
      }
      return;
    }

    if (shouldPause) {
      resumeAfterLocationChangeRef.current = false;
    } else if (isPlayingRef.current) {
      resumeAfterLocationChangeRef.current = true;
    }

    // Reset state for new content in correct order
    invalidatePlaybackRun();
    abortAudio();
    if (shouldPause) setIsPlaying(false);
    clearPlaybackSegments();
    playbackAnchorRef.current = null;
    setPlaybackAnchor(null);
    setCurrDocPage(location);

  }, [abortAudio, activeReaderType, clearPlaybackSegments, invalidatePlaybackRun, pauseActivePlayback, playbackSegmentsRef, selectPlaybackSegment]);

  const prepareInitialPosition = useCallback((location: TTSLocation) => {
    skipToLocation(location, true);
  }, [skipToLocation]);

  /**
   * Moves to the next or previous sentence
   * 
   * @param {boolean} [backwards=false] - Whether to move backwards
   */
  const advance = useCallback(async (backwards = false) => {
    const nextIndex = currentIndex + (backwards ? -1 : 1);

    // Within the plan: just move. The worker plans the whole forward extent as
    // one session, so page/section boundaries are crossed seamlessly inside the
    // playback session: `advance` never page-turns for PDF/HTML, it only moves the cursor.
    if (nextIndex < sentences.length && nextIndex >= 0) {
      selectPlaybackSegment(playbackSegmentsRef.current[nextIndex]);
      return;
    }

    // For EPUB documents, hand off to the next/prev section (its own session).
    if (isEPUB && locationChangeHandlerRef.current) {
      const direction = nextIndex >= sentences.length ? 'next' : 'prev';
      // EPUB navigation is asynchronous (rendition.next/prev -> relocated ->
      // skipToLocation → setText). Without clearing the just-finished page now,
      // an unrelated re-render during the async gap can re-fire the playback
      // effect against the *stale* last index and replay the final segment
      // before the next page loads. Reset synchronously for a deterministic handoff.
      if (isPlayingRef.current) {
        resumeAfterLocationChangeRef.current = true;
      }
      invalidatePlaybackRun();
      clearPlaybackSegments();
      playbackAnchorRef.current = null;
      setPlaybackAnchor(null);
      setCurrentSentenceAlignment(undefined);
      setCurrentWordIndex(null);
      locationChangeHandlerRef.current(direction);
      return;
    }

    // PDF/HTML: the plan already spans to the end of the forward document, so
    // running past either end of the plan is the end of playback.
    setIsPlaying(false);
  }, [clearPlaybackSegments, currentIndex, isEPUB, invalidatePlaybackRun, playbackSegmentsRef, selectPlaybackSegment, sentences]);
  advanceRef.current = advance;

  /**
   * Handles blank text sections based on document type
   * 
   * @param {string[]} sentences - Array of processed sentences
   * @returns {boolean} - True if blank section was handled
   */
  const handleBlankSection = useCallback((text: string): boolean => {
    if (!isPlaying || !skipBlank || text.length > 0) {
      return false;
    }

    // Use advance to handle navigation for both EPUB and PDF
    advance();

    toast.success(isEPUB ? 'Skipping blank section' : `Skipping blank page ${currDocPageNumber}`, {
      id: isEPUB ? `epub-section-skip` : `page-${currDocPageNumber}`,
      style: {
        background: 'var(--background)',
        color: 'var(--accent)',
      },
      duration: 1000,
      position: 'top-center',
    });

    return true;
  }, [isPlaying, skipBlank, advance, isEPUB, currDocPageNumber]);

  const applyDocumentPlaybackAnchor = useCallback((
    location: TTSLocation,
    hasReadableText: boolean,
    locator?: TTSSegmentLocator | null,
  ) => {
    let resolvedLocation: TTSLocation = location;
    let defaultLocator: TTSSegmentLocator | null = null;
    if (activeReaderType === 'pdf') {
      const page = pdfAnchorPage(location);
      if (page === null) {
        setIsProcessing(false);
        return;
      }
      resolvedLocation = page;
      defaultLocator = { readerType: 'pdf', page };
    } else if (activeReaderType === 'html') {
      defaultLocator = { readerType: 'html', location: String(resolvedLocation || '1') };
    }
    const nextAnchor: PlaybackAnchor = {
      text: '',
      location: resolvedLocation,
      locator: locator ?? defaultLocator,
      hasContent: hasReadableText,
    };
    playbackAnchorRef.current = nextAnchor;
    setPlaybackAnchor(nextAnchor);
    setCurrDocPage(resolvedLocation);

    if (playbackSyncNavigationRef.current) {
      playbackSyncNavigationRef.current = false;
      setIsProcessing(false);
      return;
    }

    const plan = playbackSegmentsRef.current;
    const planIndex = resolveFirstPlanIndexForDocumentAnchor(plan, activeReaderType, resolvedLocation);
    if (planIndex >= 0) {
      selectPlaybackSegment(plan[planIndex]);
    } else if (!playbackActiveRef.current) {
      // Document extraction is only a viewport/content anchor. If the current
      // worker plan does not cover this anchor, retire it so the plan API can
      // derive a canonical plan from the stored document artifact.
      resetPlaybackPlan();
      sentenceAlignmentCacheRef.current.clear();
      setCurrentSentenceAlignment(undefined);
      setCurrentWordIndex(null);
    }
    setIsProcessing(false);
  }, [activeReaderType, playbackActiveRef, playbackSegmentsRef, resetPlaybackPlan, selectPlaybackSegment]);

  const setDocumentPlaybackAnchor = useCallback((
    location: TTSLocation,
    hasReadableText: boolean,
    locator?: TTSSegmentLocator | null,
  ) => {
    applyDocumentPlaybackAnchor(location, hasReadableText, locator);
  }, [applyDocumentPlaybackAnchor]);

  /**
   * Records the current viewport anchor. Sentence planning is worker-owned.
   * 
   * @param {string} text - The rendered text visible at this anchor
   */
  const setText = useCallback((text: string, options?: boolean | SetTextOptions) => {
    const normalizedOptions: SetTextOptions = typeof options === 'boolean'
      ? { shouldPause: options }
      : (options || {});

    const resolvedLocation = normalizedOptions.location !== undefined
      ? normalizedOptions.location
      : currDocPage;

    // Keep currDocPage aligned with whatever the caller declared as the viewport's
    // location. This is the canonical entry point for "the rendered page now shows
    // this content at this location" — the navigation flow (handleLocationChanged →
    // skipToLocation) already set it before calling setText, so this is a no-op
    // for next/prev/jump. The path that needs it is **resize**: EPUBViewer's
    // checkResize calls extractPageText directly (bypassing skipToLocation), so
    // without this, currDocPage would stay pinned to the pre-resize CFI even
    // though the page has repaginated to a new start CFI.
    if (normalizedOptions.location !== undefined && normalizedOptions.location !== currDocPage) {
      setCurrDocPage(normalizedOptions.location);
    }

    const pendingEpubLocator = isEPUB
      && pendingEpubJumpRef.current?.epoch === epubJumpEpochRef.current
      && pendingEpubJumpRef.current.locator
      ? pendingEpubJumpRef.current.locator
      : null;
    const nextAnchor: PlaybackAnchor = {
      text,
      location: resolvedLocation,
      locator: pendingEpubLocator ?? normalizedOptions.startLocator ?? null,
      hasContent: Boolean(text.trim()),
    };
    playbackAnchorRef.current = nextAnchor;
    setPlaybackAnchor(nextAnchor);
    if (pendingEpubLocator) {
      clearPendingEpubJump();
    }

    if (playbackSyncNavigationRef.current) {
      playbackSyncNavigationRef.current = false;
      setIsProcessing(false);
      return;
    }

    if (handleBlankSection(text.trim())) return;

    const shouldPause = normalizedOptions.shouldPause ?? false;
    if (activeReaderType === 'pdf') {
      if (shouldPause) {
        resumeAfterLocationChangeRef.current = false;
        setIsPlaying(false);
      }

      const page = pdfAnchorPage(resolvedLocation) ?? pdfAnchorPage(currDocPageNumber);
      if (page === null) {
        setIsProcessing(false);
        return;
      }
      applyDocumentPlaybackAnchor(page, Boolean(text.trim()));
      return;
    }

    const pauseEpochAtStart = pauseEpochRef.current;
    const pendingAutoResume = resumeAfterLocationChangeRef.current;
    const shouldResumePlayback = !shouldPause && (isPlaying || pendingAutoResume);

    // Keep track of previous state and clear the worker-owned playback model.
    // setText now records only the visible document anchor. The worker plan is
    // the single playback and sidebar segment source.
    invalidatePlaybackRun();
    setIsPlaying(false);
    abortAudio();
    setIsProcessing(true);

    try {
      if (!text.trim()) {
        if (shouldPause || pendingAutoResume) {
          resumeAfterLocationChangeRef.current = false;
        }
        setIsProcessing(false);
        return;
      }

      if (shouldPause || pendingAutoResume) {
        resumeAfterLocationChangeRef.current = false;
      }
      clearPlaybackSegments();
      if (!pendingEpubLocator && isEPUB) {
        clearPendingEpubJump();
      }

      sentenceAlignmentCacheRef.current.clear();
      setCurrentSentenceAlignment(undefined);
      setCurrentWordIndex(null);

      setIsProcessing(false);

      if (shouldResumePlayback && pauseEpochRef.current === pauseEpochAtStart) {
        setIsPlaying(true);
      }
    } catch (error) {
      console.warn('Error processing text:', error);
      setIsProcessing(false);
      toast.error('Failed to process text', {
        duration: 3000,
      });
    }
  }, [
    isPlaying,
    handleBlankSection,
    abortAudio,
    isEPUB,
    activeReaderType,
    applyDocumentPlaybackAnchor,
    invalidatePlaybackRun,
    currDocPage,
    currDocPageNumber,
    clearPendingEpubJump,
    clearPlaybackSegments,
  ]);

  /**
   * Moves forward one sentence in the text
   */
  const skipForward = useCallback(async () => {
    const nextIndex = currentIndex + 1;
    // Move the cursor within the loaded (whole-book) plan and let the view
    // follow — same path as playback/scrubber, regardless of play state. Only
    // fall back to advance when there's no seek layout yet (plan not loaded).
    const nextSegment = playbackSegmentsRef.current[nextIndex];
    if (nextSegment && seekPlaybackToOrdinal(nextSegment.ordinal)) {
      return;
    }
    // Only show processing state if we're currently playing
    if (isPlaying) {
      setIsProcessing(true);
    }
    invalidatePlaybackRun();
    abortAudio();
    await advance();
  }, [currentIndex, playbackSegmentsRef, seekPlaybackToOrdinal, isPlaying, abortAudio, advance, invalidatePlaybackRun]);

  /**
   * Moves backward one sentence in the text
   */
  const skipBackward = useCallback(async () => {
    const nextIndex = currentIndex - 1;
    const nextSegment = playbackSegmentsRef.current[nextIndex];
    if (nextIndex >= 0 && nextSegment && seekPlaybackToOrdinal(nextSegment.ordinal)) {
      return;
    }
    // Only show processing state if we're currently playing
    if (isPlaying) {
      setIsProcessing(true);
    }
    invalidatePlaybackRun();
    abortAudio();
    await advance(true);
  }, [currentIndex, playbackSegmentsRef, seekPlaybackToOrdinal, isPlaying, abortAudio, advance, invalidatePlaybackRun]);


  /**
   * Updates the voice and speed settings from the configuration
   */
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

  const resolvePlaybackAnchorLocation = useCallback((): PlaybackStartLocation => {
    const anchor = playbackAnchorRef.current;
    if (activeReaderType === 'pdf') {
      const page = pdfAnchorPage(anchor?.location) ?? pdfAnchorPage(currDocPageNumber);
      return page === null ? {} : { page };
    }
    if (activeReaderType === 'html') {
      return { page: (anchor?.location ?? currDocPage) || '1' };
    }
    if (activeReaderType === 'epub') {
      const locator = isStableEpubLocator(anchor?.locator) ? anchor.locator : null;
      if (!locator) return {};
      const charOffset = typeof locator.charOffset === 'number' && Number.isFinite(locator.charOffset)
        ? Math.max(0, Math.floor(locator.charOffset))
        : null;
      if (charOffset === null) return {};
      return {
        spineIndex: Math.max(0, locator.spineIndex),
        charOffset,
      };
    }
    return {};
  }, [activeReaderType, currDocPage, currDocPageNumber]);

  const buildPlaybackPlanRequest = useCallback((): {
    payload: TtsPlaybackPlanPayload;
    headers: TTSRequestHeaders;
  } | null => {
    if (!documentId) {
      return null;
    }

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
    providerModelPolicy.supportsInstructions,
    pdfSkipBlockKinds,
    resolvedLanguage,
    ttsInstructions,
    ttsModel,
    ttsSegmentMaxBlockLength,
    voice,
  ]);

  const buildPlaybackSessionRequest = useCallback((): {
    payload: TtsPlaybackPlanPayload;
    headers: TTSRequestHeaders;
    selectedOrdinal: number;
  } | null => {
    const request = buildPlaybackPlanRequest();
    const ordinal = selectedOrdinalRef.current;
    if (!request || ordinal === null || !Number.isFinite(ordinal)) return null;
    return {
      ...request,
      selectedOrdinal: Math.max(0, Math.floor(ordinal)),
    };
  }, [buildPlaybackPlanRequest, selectedOrdinalRef]);

  const fetchPlaybackPlanUntilReady = useCallback(async (
    planUrl: string,
    signal?: AbortSignal,
  ) => {
    const fetchPlan = async () => {
      const res = await fetch(planUrl, { cache: 'no-store', signal });
      if (!res.ok) return null;
      return normalizePlaybackPlan(await res.json());
    };
    let plan = await fetchPlan();
    for (let attempt = 0; (!plan || plan.segments.length === 0) && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (signal?.aborted) return null;
      plan = await fetchPlan();
    }
    return plan && plan.segments.length > 0 ? plan : null;
  }, []);

  const fetchPlaybackSeekLayoutUntilReady = useCallback(async (
    seekLayoutUrl: string,
    signal?: AbortSignal,
  ) => {
    const fetchLayout = async () => {
      const layout = await getTtsPlaybackSeekLayout(seekLayoutUrl, signal).catch(() => null);
      return layout && layout.durationMs > 0 && layout.segments.length > 0 ? layout : null;
    };

    let layout = await fetchLayout();
    for (let attempt = 0; !layout && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (signal?.aborted) return null;
      layout = await fetchLayout();
    }
    return layout;
  }, []);

  const isAbortLikeError = useCallback((err: unknown): boolean => {
    if (err instanceof Error) {
      return err.name === 'AbortError' || /abort|cancel/i.test(err.message || '');
    }
    if (typeof err === 'string') return /abort|cancel/i.test(err);
    if (typeof err === 'object' && err !== null && 'message' in err) {
      const maybe = (err as { message?: unknown }).message;
      return typeof maybe === 'string' && /abort|cancel/i.test(maybe);
    }
    return false;
  }, []);

  const applyPlaybackPlan = useCallback((plan: ReturnType<typeof normalizePlaybackPlan>): ReturnType<typeof normalizePlaybackPlan> => {
    const canonicalPlan = applyWorkerPlan(plan);
    const startPlanIndex = resolvePlanBackedSelectionIndex({
      plan: canonicalPlan,
      readerType: activeReaderType,
      selectedOrdinal: selectedOrdinalRef.current,
      anchorLocation: resolvePlaybackAnchorLocation(),
    });
    const startSegment = canonicalPlan[startPlanIndex];
    if (!startSegment) {
      throw new Error('TTS playback plan did not contain a plan-backed selection for the current anchor');
    }
    setSelectedOrdinal(startSegment.ordinal);
    return plan;
  }, [activeReaderType, applyWorkerPlan, resolvePlaybackAnchorLocation, selectedOrdinalRef, setSelectedOrdinal]);

  const createAndApplyPlaybackPlan = useCallback(async (
    request: ReturnType<typeof buildPlaybackPlanRequest>,
    signal?: AbortSignal,
  ) => {
    if (!request) return null;
    const existing = playbackPlanRef.current;
    if (existing?.planObjectKey && existing.segments.length > 0) {
      if (existing.planId && !playbackSeekLayout) {
        const layout = await fetchPlaybackSeekLayoutUntilReady(
          `/api/tts/playback/plans/${encodeURIComponent(existing.planId)}/seek-layout`,
          signal,
        );
        if (!signal?.aborted && layout) setPlaybackSeekLayout(layout);
      }
      return applyPlaybackPlan(existing);
    }
    const planHandle = await createTtsPlaybackPlan(request.payload, request.headers, signal);
    const plan = await fetchPlaybackPlanUntilReady(planHandle.planUrl, signal);
    if (!plan) return null;
    const layout = await fetchPlaybackSeekLayoutUntilReady(planHandle.seekLayoutUrl, signal);
    if (!signal?.aborted && layout) setPlaybackSeekLayout(layout);
    return applyPlaybackPlan(plan);
  }, [
    applyPlaybackPlan,
    fetchPlaybackPlanUntilReady,
    fetchPlaybackSeekLayoutUntilReady,
    playbackPlanRef,
    playbackSeekLayout,
    setPlaybackSeekLayout,
  ]);

  const resolveDocumentAudioExportInternal = useCallback(async (
    options: { format: 'mp3' | 'm4b'; speed: number },
    start: boolean,
    signal?: AbortSignal,
  ): Promise<TtsDocumentAudioExportResolution> => {
    const request = buildPlaybackPlanRequest();
    if (!request) {
      throw new Error('No document is ready for audio export.');
    }

    let plan = playbackPlanRef.current;
    if (!plan?.planObjectKey || plan.segments.length === 0) {
      const planHandle = await createTtsPlaybackPlan(request.payload, request.headers, signal);
      plan = await fetchPlaybackPlanUntilReady(planHandle.planUrl, signal);
      if (!signal?.aborted) {
        const layout = await fetchPlaybackSeekLayoutUntilReady(planHandle.seekLayoutUrl, signal);
        if (layout) setPlaybackSeekLayout(layout);
      }
    }

    if (!plan?.planObjectKey || plan.segments.length === 0) {
      throw new Error('The worker playback plan was not ready for export.');
    }

    const canonicalPlan = applyWorkerPlan(plan);
    if (canonicalPlan.length === 0) {
      throw new Error('The worker playback plan was empty for export.');
    }

    const snapshot = await resolveTtsExport({
      documentId: request.payload.documentId,
      settings: request.payload.settings,
      ...(request.payload.planning ? { planning: request.payload.planning } : {}),
      startIntent: { selectedOrdinal: 0 },
      ...(plan.planId ? { planId: plan.planId } : {}),
      planObjectKey: plan.planObjectKey,
      ...(plan.planSignature ? { planSignature: plan.planSignature } : {}),
      generationExtent: 'document',
      format: options.format,
      speed: options.speed,
      start,
    }, request.headers, signal);

    const plannedCount = plan.plannedCount ?? plan.segments.length;
    const generationProgress = snapshot.generation.progress ?? snapshot.generation.operation?.progress ?? null;
    const progressCompletedCount = generationProgress && Number.isFinite(Number(generationProgress.completedCount))
      ? Math.max(0, Math.floor(Number(generationProgress.completedCount)))
      : generationProgress && Number.isFinite(Number(generationProgress.completedThroughOrdinal))
        ? Math.max(0, Math.floor(Number(generationProgress.completedThroughOrdinal)) + 1)
        : null;
    const generationStatus = snapshot.generation.operation?.status ?? snapshot.generation.session?.status ?? null;
    const artifactStatus = snapshot.artifact.artifact ? 'succeeded' : snapshot.artifact.operation?.status ?? null;
    const completedCount = snapshot.downloadUrl || artifactStatus === 'succeeded' || generationStatus === 'succeeded'
      ? plannedCount
      : progressCompletedCount === null
        ? null
        : Math.min(plannedCount, progressCompletedCount);

    return {
      sessionId: snapshot.sessionId,
      artifactId: snapshot.artifactId,
      downloadUrl: snapshot.downloadUrl,
      generationOperationId: snapshot.generation.operation?.opId ?? null,
      artifactOperationId: snapshot.artifact.operation?.opId ?? null,
      generationStatus,
      artifactStatus,
      seekLayoutUrl: plan.planId
        ? `/api/tts/playback/plans/${encodeURIComponent(plan.planId)}/seek-layout?sessionId=${encodeURIComponent(snapshot.sessionId)}`
        : '',
      plannedCount,
      completedCount,
    };
  }, [
    applyWorkerPlan,
    buildPlaybackPlanRequest,
    fetchPlaybackPlanUntilReady,
    fetchPlaybackSeekLayoutUntilReady,
    playbackPlanRef,
    setPlaybackSeekLayout,
  ]);

  const resolveDocumentAudioExport = useCallback((
    options: { format: 'mp3' | 'm4b'; speed: number },
    signal?: AbortSignal,
  ) => resolveDocumentAudioExportInternal(options, false, signal), [resolveDocumentAudioExportInternal]);

  const startDocumentAudioExport = useCallback((
    options: { format: 'mp3' | 'm4b'; speed: number },
    signal?: AbortSignal,
  ) => resolveDocumentAudioExportInternal(options, true, signal), [resolveDocumentAudioExportInternal]);

  buildPlaybackPlanRequestRef.current = buildPlaybackPlanRequest;
  buildPlaybackSessionRequestRef.current = buildPlaybackSessionRequest;
  createAndApplyPlaybackPlanRef.current = createAndApplyPlaybackPlan;
  applyPlaybackPlanRef.current = applyPlaybackPlan;

  useEffect(() => {
    if (isPlaying || playbackPlanSource === 'worker') return;
    if (!playbackAnchor?.hasContent && !playbackAnchor?.text.trim()) return;
    const request = buildPlaybackPlanRequest();
    if (!request) return;

    const controller = new AbortController();
    const runId = ++planPreviewRunIdRef.current;

    void (async () => {
      try {
        const session = await createTtsPlaybackPlan(request.payload, request.headers, controller.signal);
        if (controller.signal.aborted || runId !== planPreviewRunIdRef.current) return;
        const plan = await fetchPlaybackPlanUntilReady(session.planUrl, controller.signal);
        if (controller.signal.aborted || runId !== planPreviewRunIdRef.current || !plan) return;

        const layout = await fetchPlaybackSeekLayoutUntilReady(session.seekLayoutUrl, controller.signal);
        if (controller.signal.aborted || runId !== planPreviewRunIdRef.current || !layout) return;
        setPlaybackSeekLayout(layout);
        applyPlaybackPlan(plan);
      } catch (error) {
        if (controller.signal.aborted || isAbortLikeError(error)) return;
        console.warn('Failed to prefetch TTS playback plan:', error);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [
    buildPlaybackPlanRequest,
    applyPlaybackPlan,
    fetchPlaybackPlanUntilReady,
    fetchPlaybackSeekLayoutUntilReady,
    isAbortLikeError,
    isPlaying,
    playbackAnchor,
    playbackPlanSource,
    setPlaybackSeekLayout,
  ]);

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

  const clearSegmentCaches = useCallback(() => {
    // A server-side clear deletes every generated-audio object and the segment
    // index for this document. The cached plan/seek-layout/segments now point at
    // artifacts that no longer exist, so we must drop them all — otherwise the
    // next play reuses the stale plan and the audio stream waits forever on a
    // start ordinal whose audio was deleted (the "unplayable after clear" bug).
    // Resetting plan source to 'idle' also lets the plan-preview effect rebuild a
    // fresh plan + seek layout for the scrubber/grid.
    const wasPlaying = isPlaying;
    const mySeq = ++restartSeqRef.current;
    resetPlaybackPlan({ resetSelection: false });
    abortAudio();
    sentenceAlignmentCacheRef.current.clear();
    setCurrentSentenceAlignment(undefined);
    setCurrentWordIndex(null);
    if (!wasPlaying) return;
    // Bridge two renders so the playback driver sees a real false→true edge and
    // requests a brand-new session that regenerates the cleared segments.
    setIsProcessing(true);
    setIsPlaying(false);
    window.setTimeout(() => {
      setIsProcessing(false);
      if (mySeq === restartSeqRef.current) {
        setIsPlaying(true);
      }
    }, 0);
  }, [abortAudio, isPlaying, resetPlaybackPlan]);

  const stopAndPlayFromOrdinal = useCallback((ordinal: number) => {
    if (!Number.isFinite(ordinal)) return;
    const normalizedOrdinal = Math.max(0, Math.floor(ordinal));
    if (!playbackSegmentsRef.current.some((segment) => segment.ordinal === normalizedOrdinal)) return;
    invalidatePlaybackRun();
    abortAudio();

    // Same autoplay-unlock issue as togglePlay when starting from a fresh load.
    unlockPlaybackOnUserGesture();

    setSelectedOrdinal(normalizedOrdinal);
    setIsPlaying(true);
  }, [abortAudio, invalidatePlaybackRun, playbackSegmentsRef, setSelectedOrdinal, unlockPlaybackOnUserGesture]);

  const playFromOrdinal = useCallback((ordinal: number, locator?: TTSSegmentLocator | null) => {
    if (!Number.isFinite(ordinal)) return;
    const targetOrdinal = Math.max(0, Math.floor(ordinal));
    const targetSegment = playbackSegmentsRef.current.find((segment) => segment.ordinal === targetOrdinal);
    if (!targetSegment) return;
    if (isEPUB) {
      clearPendingEpubJump();
    }

    if (activeReaderType === 'pdf') {
      const targetLocator = locator ?? targetSegment?.ownerLocator ?? null;
      setSelectedOrdinal(targetOrdinal);
      const page = pdfLocatorPage(targetLocator);
      if (page !== null) {
        setCurrDocPage(page);
      }
      if (playbackActiveRef.current && seekPlaybackToOrdinal(targetOrdinal)) {
        return;
      }
      unlockPlaybackOnUserGesture();
      setIsPlaying(true);
      return;
    }

    const epubLocatorTarget = isEPUB && isStableEpubLocator(locator) ? locator : null;
    const resolvedLocation: TTSLocation | undefined = (() => {
      if (!locator) return undefined;
      // Stable EPUB locators carry the jump-hint CFI in `cfi`, not `location`
      // (which is reserved for HTML locator identity).
      if (locator.readerType === 'epub' && typeof locator.cfi === 'string' && locator.cfi) {
        return locator.cfi;
      }
      if (typeof locator.location === 'string' && locator.location) return locator.location;
      const page = pdfLocatorPage(locator);
      if (page !== null) return page;
      return undefined;
    })();

    if (resolvedLocation === undefined && !epubLocatorTarget) {
      stopAndPlayFromOrdinal(targetOrdinal);
      return;
    }

    if (isEPUB && epubLocatorTarget) {
      const nextAnchor: PlaybackAnchor = {
        text: targetSegment?.text ?? '',
        location: epubLocatorTarget.cfi ?? currDocPage,
        locator: epubLocatorTarget,
        hasContent: Boolean(targetSegment?.text?.trim()),
      };
      playbackAnchorRef.current = nextAnchor;
      setPlaybackAnchor(nextAnchor);
    }

    const isSameLocation = resolvedLocation !== undefined && typeof resolvedLocation === 'string'
      ? String(currDocPage) === String(resolvedLocation)
      : resolvedLocation !== undefined && pdfAnchorPage(currDocPageNumber) === pdfAnchorPage(resolvedLocation);

    if (isSameLocation) {
      stopAndPlayFromOrdinal(targetOrdinal);
      return;
    }

    invalidatePlaybackRun();
    abortAudio();
    unlockPlaybackOnUserGesture();
    if (isEPUB) {
      // CFI snapping makes locationKey unreliable; resolve via epoch on next setText.
      pendingEpubJumpRef.current = {
        epoch: epubJumpEpochRef.current,
        locator: epubLocatorTarget,
      };
    }
    resumeAfterLocationChangeRef.current = true;
    setSelectedOrdinal(targetOrdinal);
    setIsPlaying(true);
    if (isEPUB && locationChangeHandlerRef.current) {
      locationChangeHandlerRef.current(epubLocatorTarget ?? resolvedLocation!);
      return;
    }
    if (resolvedLocation !== undefined) {
      skipToLocation(resolvedLocation, false);
    }
  }, [
    stopAndPlayFromOrdinal,
    activeReaderType,
    playbackSegmentsRef,
    playbackActiveRef,
    seekPlaybackToOrdinal,
    currDocPage,
    currDocPageNumber,
    isEPUB,
    invalidatePlaybackRun,
    abortAudio,
    unlockPlaybackOnUserGesture,
    skipToLocation,
    clearPendingEpubJump,
    setSelectedOrdinal,
  ]);

  /**
   * Sets the speed and restarts the playback
   * 
   * @param {number} newSpeed - The new speed to set
   */
  const setSpeedAndRestart = useCallback((newSpeed: number) => {
    const wasPlaying = isPlaying;

    // Bump restart sequence to invalidate older restarts
    const mySeq = ++restartSeqRef.current;

    // Set a flag to prevent double audio requests during config update
    setIsProcessing(true);

    // First stop any current playback
    setIsPlaying(false);
    clearPendingEpubJump();
    abortAudio();
    resetPlaybackPlan({ resetSelection: false });

    // Update speed and config
    setSpeed(newSpeed);

    // Update config after state changes
    updateConfigKey('voiceSpeed', newSpeed).then(() => {
      setIsProcessing(false);
      // Resume playback if it was playing before and this is the latest restart
      if (wasPlaying && mySeq === restartSeqRef.current) {
        setIsPlaying(true);
      }
    });
  }, [abortAudio, updateConfigKey, isPlaying, clearPendingEpubJump, resetPlaybackPlan]);

  /**
   * Sets the voice and restarts the playback
   * 
   * @param {string} newVoice - The new voice to set
   */
  const setVoiceAndRestart = useCallback((newVoice: string) => {
    const wasPlaying = isPlaying;

    // Bump restart sequence to invalidate older restarts
    const mySeq = ++restartSeqRef.current;

    // Set a flag to prevent double audio requests during config update
    setIsProcessing(true);

    // First stop any current playback
    setIsPlaying(false);
    clearPendingEpubJump();
    abortAudio();
    resetPlaybackPlan({ resetSelection: false });

    // Update voice and config
    setVoice(newVoice);

    // Update config after state changes
    updateConfigKey('voice', newVoice).then(() => {
      setIsProcessing(false);
      // Resume playback if it was playing before and this is the latest restart
      if (wasPlaying && mySeq === restartSeqRef.current) {
        setIsPlaying(true);
      }
    });
  }, [abortAudio, updateConfigKey, isPlaying, clearPendingEpubJump, resetPlaybackPlan]);

  /**
   * Sets the audio player speed and restarts the playback
   * 
   * @param {number} newSpeed - The new audio player speed to set
   */
  const setAudioPlayerSpeedAndRestart = useCallback((newSpeed: number) => {
    const wasPlaying = isPlaying;

    // Bump restart sequence to invalidate older restarts
    const mySeq = ++restartSeqRef.current;

    // Set a flag to prevent double audio requests during config update
    setIsProcessing(true);

    // First stop any current playback
    setIsPlaying(false);
    clearPendingEpubJump();
    abortAudio();

    // Update audio speed and config
    setAudioSpeed(newSpeed);

    // Update config after state changes
    updateConfigKey('audioPlayerSpeed', newSpeed).then(() => {
      setIsProcessing(false);
      // Resume playback if it was playing before and this is the latest restart
      if (wasPlaying && mySeq === restartSeqRef.current) {
        setIsPlaying(true);
      }
    });
  }, [abortAudio, updateConfigKey, isPlaying, clearPendingEpubJump]);

  /**
   * Drops the cached position-independent playback plan and its derived seek
   * layout so the next playback fetches a fresh one. Callers that mutate
   * segmentation knobs must invalidate explicitly, mirroring how voice/speed
   * changes reset the plan in `setVoiceAndRestart`. Resumes playback if it was
   * active so the change takes effect immediately.
   */
  const invalidatePlaybackPlan = useCallback(() => {
    const wasPlaying = isPlaying;
    const mySeq = ++restartSeqRef.current;
    resetPlaybackPlan({ resetSelection: false });
    if (!wasPlaying) return;
    setIsProcessing(true);
    setIsPlaying(false);
    abortAudio();
    // Bridge two renders so the playback driver sees a real false→true edge.
    window.setTimeout(() => {
      setIsProcessing(false);
      if (mySeq === restartSeqRef.current) {
        setIsPlaying(true);
      }
    }, 0);
  }, [abortAudio, isPlaying, resetPlaybackPlan]);

  /**
   * Provides the TTS context value to child components
   */
  const value = useMemo(() => ({
    isPlaying,
    isProcessing,
    currentSentence,
    currentSegment,
    sentences,
    playbackSegments,
    playbackPlanSource,
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
    stopAndPlayFromOrdinal,
    playFromOrdinal,
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
    playbackSegments,
    playbackPlanSource,
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
    stopAndPlayFromOrdinal,
    playFromOrdinal,
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

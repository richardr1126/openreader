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
import {
  createTtsPlaybackPlan,
  createTtsPlaybackSession,
  getTtsPlaybackSeekLayout,
  postTtsPlaybackCursor,
  subscribeTtsPlaybackEvents,
  type TtsPlaybackSeekLayout,
  type TtsPlaybackSessionPayload,
} from '@/lib/client/api/tts';
import {
  normalizePlaybackPlan,
  playbackPlanToCanonicalSegments,
} from '@/lib/client/tts/playback-plan';
import { preprocessSentenceForAudio } from '@openreader/tts/nlp';
import {
  type CanonicalTtsSegment,
} from '@openreader/tts/segment-plan';
import { normalizeTtsLocationKey } from '@openreader/tts/locator';
import { resolveTtsProviderModelPolicy } from '@openreader/tts/provider-policy';
import { resolveTtsLanguage } from '@openreader/tts/language';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import { TTS_PLAYBACK_CURSOR_HEARTBEAT_MS } from '@/types/tts';
import type {
  TTSLocation,
  TTSPlaybackState,
  TTSSentenceAlignment,
} from '@/types/tts';
import type {
  TTSRequestHeaders,
  TTSSegmentLocator,
} from '@/types/client';
import { isStableEpubLocator } from '@/types/client';

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
  currentSentenceIndex: number;
  playbackTimeSec: number;
  playbackDurationSec: number;
  playbackSeekLayout: TtsPlaybackSeekLayout | null;

  // Alignment metadata for the current sentence
  currentSentenceAlignment?: TTSSentenceAlignment;
  currentWordIndex?: number | null;

  // Control functions
  togglePlay: () => void;
  skipForward: () => void;
  skipBackward: () => void;
  pause: () => void;
  stop: () => void;
  stopAndPlayFromIndex: (index: number) => void;
  playFromSegment: (index: number, locator?: TTSSegmentLocator | null) => void;
  seekPlaybackTo: (seconds: number) => void;
  setText: (text: string, options?: boolean | SetTextOptions) => void;
  setCurrDocPages: (num: number | undefined) => void;
  setSpeedAndRestart: (speed: number) => void;
  setAudioPlayerSpeedAndRestart: (speed: number) => void;
  setVoiceAndRestart: (voice: string) => void;
  documentLanguage: string;
  resolvedLanguage: string;
  setDocumentLanguage: (language: string) => void;
  clearSegmentCaches: () => void;
  skipToLocation: (location: TTSLocation, shouldPause?: boolean) => void;
  prepareInitialPosition: (location: TTSLocation, sentenceIndex: number) => void;
  registerLocationChangeHandler: (handler: ((location: TTSLocation | TTSSegmentLocator) => void) | null) => void;  // EPUB-only: Handles chapter navigation
  setIsEPUB: (isEPUB: boolean) => void;
  /** Effective reader type used for worker playback/session scoping. */
  activeReaderType: ReaderType;
}

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

type TTSPendingJumpTarget = {
  locationKey: string;
  index: number;
};

type PlaybackAnchor = {
  text: string;
  location: TTSLocation;
  locator: TTSSegmentLocator | null;
};

// Read once per module load from SSR-injected runtime config. This sits at
// module scope because the highlight pipeline is constructed lazily and the
// flag rarely changes within a session — admin toggling it picks up on
// reload, matching the SSR-injection model.
const wordHighlightFeatureEnabled = (() => {
  if (typeof window === 'undefined') return true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const injected = (window as any).__RUNTIME_CONFIG__;
  if (!injected || typeof injected !== 'object') return true;
  return typeof injected.computeAvailable === 'boolean'
    ? injected.computeAvailable
    : true;
})();

// Tiny silent WAV used to unlock HTML5 audio on iOS/Safari.
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

const normalizeLocationKey = normalizeTtsLocationKey;

const normalizeStartMatchText = (text: string): string =>
  preprocessSentenceForAudio(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const locatorMatchesPlaybackStart = (
  locator: TTSSegmentLocator | null | undefined,
  startLocation: { page?: number; spineIndex?: number; charOffset?: number },
): boolean => {
  if (!locator) return false;
  if (locator.readerType === 'pdf') {
    return typeof startLocation.page === 'number' && locator.page === startLocation.page;
  }
  if (locator.readerType === 'epub') {
    return typeof startLocation.spineIndex === 'number' && locator.spineIndex === startLocation.spineIndex;
  }
  return true;
};

const resolvePlaybackStartIndex = (input: {
  plan: CanonicalTtsSegment[];
  desiredSegment?: CanonicalTtsSegment;
  desiredText: string;
  startLocation: { page?: number; spineIndex?: number; charOffset?: number };
}): number => {
  if (input.plan.length === 0) return 0;
  if (input.desiredSegment?.key) {
    const byKey = input.plan.findIndex((segment) => segment.key === input.desiredSegment!.key);
    if (byKey >= 0) return byKey;
  }
  if (typeof input.startLocation.spineIndex === 'number' && typeof input.startLocation.charOffset === 'number') {
    const byEpubCoordinate = input.plan.findIndex((segment) => {
      const locator = segment.ownerLocator;
      if (locator?.readerType !== 'epub' || typeof locator.spineIndex !== 'number') return false;
      if (locator.spineIndex > input.startLocation.spineIndex!) return true;
      if (locator.spineIndex < input.startLocation.spineIndex!) return false;
      return typeof locator.charOffset !== 'number' || locator.charOffset >= input.startLocation.charOffset!;
    });
    if (byEpubCoordinate >= 0) return byEpubCoordinate;
  }

  const desiredText = normalizeStartMatchText(input.desiredSegment?.text ?? input.desiredText);
  if (desiredText) {
    const sameLocation = input.plan.findIndex((segment) =>
      locatorMatchesPlaybackStart(segment.ownerLocator, input.startLocation)
      && normalizeStartMatchText(segment.text) === desiredText
    );
    if (sameLocation >= 0) return sameLocation;

    const sameText = input.plan.findIndex((segment) => normalizeStartMatchText(segment.text) === desiredText);
    if (sameText >= 0) return sameText;
  }

  return 0;
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
    pdfHighlightEnabled,
    pdfWordHighlightEnabled,
    epubHighlightEnabled,
    epubWordHighlightEnabled,
  } = useConfig();

  // Audio and voice management hooks
  const audioContext = useAudioContext();
  const { availableVoices } = useVoiceManagement(
    configProviderRef,
    configProviderType,
    configTTSModel,
  );
  const {
    refresh: refreshRateLimit,
    triggerRateLimit,
  } = useAuthRateLimit();

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

  const [sentences, setSentences] = useState<string[]>([]);
  const [playbackSegments, setPlaybackSegments] = useState<CanonicalTtsSegment[]>([]);
  const [playbackPlanSource, setPlaybackPlanSource] = useState<'idle' | 'worker'>('idle');
  const [playbackSeekLayout, setPlaybackSeekLayout] = useState<TtsPlaybackSeekLayout | null>(null);
  const [playbackTimeSec, setPlaybackTimeSec] = useState(0);
  const playbackSegmentsRef = useRef<CanonicalTtsSegment[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [speed, setSpeed] = useState(voiceSpeed);
  const [audioSpeed, setAudioSpeed] = useState(audioPlayerSpeed);
  const [voice, setVoice] = useState(configVoice);
  const [ttsModel, setTTSModel] = useState(configTTSModel);
  const [ttsInstructions, setTTSInstructions] = useState(configTTSInstructions);
  const [documentLanguage, setDocumentLanguage] = useState('auto');
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

  // Synchronous guard to prevent duplicate playback calls from the main
  // playback effect while React state updates are still settling.
  const playbackInFlightRef = useRef(false);
  const playbackRunIdRef = useRef(0);
  const pendingJumpTargetRef = useRef<TTSPendingJumpTarget | null>(null);
  // EPUB-only jump resolution. epub.js navigation snaps CFIs to page-aligned
  // values, so the strict locationKey match in pendingJumpTargetRef misses on
  // cross-spine jumps. We instead bump an epoch on each playFromSegment call
  // and let the next setText with a matching epoch consume the jump.
  const pendingEpubJumpRef = useRef<{ index: number; epoch: number; locator?: TTSSegmentLocator | null } | null>(null);
  const epubJumpEpochRef = useRef<number>(0);
  // Guard to coalesce rapid restarts and only resume the latest change
  const restartSeqRef = useRef(0);
  // Preserve autoplay intent across location changes. Some browsers can emit pause
  // events while we stop/unload between pages, which momentarily flips `isPlaying`
  // false and can prevent automatic resume on the next page.
  const resumeAfterLocationChangeRef = useRef(false);
  const pageTurnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentenceAlignmentCacheRef = useRef<Map<string, TTSSentenceAlignment>>(new Map());
  const [currentSentenceAlignment, setCurrentSentenceAlignment] = useState<TTSSentenceAlignment | undefined>();
  const [currentWordIndex, setCurrentWordIndex] = useState<number | null>(null);
  const isPlayingRef = useRef(false);
  const pauseEpochRef = useRef(0);
  const playbackAnchorRef = useRef<PlaybackAnchor | null>(null);
  const [playbackAnchor, setPlaybackAnchor] = useState<PlaybackAnchor | null>(null);
  const planPreviewRunIdRef = useRef(0);
  const sentencesRef = useRef<string[]>([]);
  const currentIndexRef = useRef(0);
  // Last worker-plan EPUB position. Used as a resume anchor when epub.js
  // navigation lands before the next visible locator is recorded.
  const lastPlayedCanonicalRef = useRef<{ spineHref: string; spineIndex: number; ordinal: number } | null>(null);
  const audioUnlockAttemptRef = useRef(0);
  const playbackProjectionRafRef = useRef<number | null>(null);
  const playbackRequestHeadersRef = useRef<TTSRequestHeaders | null>(null);
  const playbackPlanRef = useRef<ReturnType<typeof normalizePlaybackPlan> | null>(null);
  // One persistent <audio> element reused for every playback session. iOS Safari
  // autoplay unlock is per-element: the element that gets play()'d inside a user
  // gesture is the only one allowed to play() later. The playback source is set
  // after async awaits (session create, plan fetch) — long outside the
  // gesture — so it must reuse THIS pre-unlocked element rather than minting a
  // fresh `new Audio()` that Safari would block.
  const unlockedAudioRef = useRef<HTMLAudioElement | null>(null);

  const {
    playbackActiveRef,
    playbackCursorIntervalRef,
    playbackEventsUnsubRef,
    playbackSessionRef,
    projectPlaybackTime,
    refreshPlaybackTimeline,
    resetPlaybackRefs,
    stopPlaybackTimelinePolling,
  } = useTtsPlayback({
    playbackSegmentsRef,
    currentIndexRef,
    setCurrDocPage,
    setCurrentIndex,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
  });

  const unlockPlaybackOnUserGesture = useCallback(() => {
    // Best-effort; safe to call multiple times.
    audioUnlockAttemptRef.current += 1;
    const attempt = audioUnlockAttemptRef.current;

    try {
      void audioContext?.resume();
    } catch {
      // ignore
    }

    try {
      let el = unlockedAudioRef.current;
      if (!el) {
        el = new Audio();
        try {
          el.setAttribute('playsinline', 'true');
        } catch {
          // ignore
        }
        el.preload = 'auto';
        unlockedAudioRef.current = el;
      }
      // Play a silent source on the persistent element WITHIN this gesture so
      // Safari marks it as user-activated; the worker playback URL reuses it later.
      el.src = SILENT_WAV_DATA_URI;
      el.volume = 0;

      const p = el.play();
      if (p && typeof (p as Promise<void>).then === 'function') {
        void (p as Promise<void>)
          .then(() => {
            if (audioUnlockAttemptRef.current !== attempt) return;
            try {
              el!.pause();
              el!.currentTime = 0;
              el!.volume = 1;
            } catch {
              // ignore
            }
          })
          .catch(() => {
            // ignore
          });
      }
    } catch {
      // ignore
    }
  }, [audioContext]);

  const invalidatePlaybackRun = useCallback(() => {
    playbackRunIdRef.current += 1;
    playbackInFlightRef.current = false;
  }, []);

  const clearPendingEpubJump = useCallback(() => {
    pendingEpubJumpRef.current = null;
    epubJumpEpochRef.current += 1;
  }, []);

  const isAbortLikeError = useCallback((err: unknown): boolean => {
    if (err instanceof Error) {
      return err.name === 'AbortError' || /abort|cancel/i.test(err.message || '');
    }
    if (typeof err === 'string') {
      return /abort|cancel/i.test(err);
    }
    if (typeof err === 'object' && err !== null && 'message' in err) {
      const maybe = (err as { message?: unknown }).message;
      if (typeof maybe === 'string') {
        return /abort|cancel/i.test(maybe);
      }
    }
    return false;
  }, []);

  useEffect(() => {
    sentencesRef.current = sentences;
  }, [sentences]);

  useEffect(() => {
    playbackSegmentsRef.current = playbackSegments;
  }, [playbackSegments]);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  const stopPlaybackProjectionLoop = useCallback(() => {
    if (playbackProjectionRafRef.current !== null) {
      cancelAnimationFrame(playbackProjectionRafRef.current);
      playbackProjectionRafRef.current = null;
    }
  }, []);

  const startPlaybackForegroundSync = useCallback((runId: number, headers: TTSRequestHeaders) => {
    const activeSession = playbackSessionRef.current;
    if (!activeSession) return;

    stopPlaybackTimelinePolling();
    void refreshPlaybackTimeline(activeSession.timelineUrl).catch(() => undefined);
    playbackEventsUnsubRef.current = subscribeTtsPlaybackEvents(activeSession.sessionId, {
      onSnapshot: (snapshot) => {
        if (runId !== playbackRunIdRef.current) return;
        if (snapshot.status === 'failed') return;
        const currentSession = playbackSessionRef.current;
        if (!currentSession) return;
        void refreshPlaybackTimeline(currentSession.timelineUrl)
          .catch(() => undefined);
        if (currentSession.seekLayoutUrl) {
          void getTtsPlaybackSeekLayout(currentSession.seekLayoutUrl)
            .then((layout) => {
              if (runId !== playbackRunIdRef.current) return;
              setPlaybackSeekLayout(layout);
            })
            .catch(() => undefined);
        }
      },
    });

    const writeCursor = () => {
      const currentSession = playbackSessionRef.current;
      if (!currentSession) return;
      const cursor = Math.max(0, currentIndexRef.current);
      void postTtsPlaybackCursor(currentSession.sessionId, cursor, headers);
    };
    writeCursor();
    playbackCursorIntervalRef.current = setInterval(() => {
      if (runId !== playbackRunIdRef.current) return;
      writeCursor();
    }, TTS_PLAYBACK_CURSOR_HEARTBEAT_MS);
  }, [
    playbackCursorIntervalRef,
    playbackEventsUnsubRef,
    playbackSessionRef,
    refreshPlaybackTimeline,
    stopPlaybackTimelinePolling,
  ]);

  const startPlaybackProjectionLoop = useCallback((audio: HTMLAudioElement, runId: number) => {
    stopPlaybackProjectionLoop();

    const tick = () => {
      if (runId !== playbackRunIdRef.current || audio.paused || audio.ended) {
        playbackProjectionRafRef.current = null;
        return;
      }
      setPlaybackTimeSec(audio.currentTime);
      projectPlaybackTime(audio.currentTime);
      playbackProjectionRafRef.current = requestAnimationFrame(tick);
    };

    setPlaybackTimeSec(audio.currentTime);
    projectPlaybackTime(audio.currentTime);
    playbackProjectionRafRef.current = requestAnimationFrame(tick);
  }, [projectPlaybackTime, stopPlaybackProjectionLoop]);

  /**
   * Stops the current audio playback and optionally clears pending requests.
   */
  const abortAudio = useCallback((clearPending = false) => {
    // Ensure next playback attempt is not blocked by a stale in-flight guard.
    invalidatePlaybackRun();
    stopPlaybackProjectionLoop();
    resetPlaybackRefs();
    playbackPlanRef.current = null;
    setPlaybackSeekLayout(null);
    setPlaybackTimeSec(0);
    playbackRequestHeadersRef.current = null;
    const audio = unlockedAudioRef.current;
    if (audio) {
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch {
        // ignore teardown errors
      }
    }

    if (pageTurnTimeoutRef.current) {
      clearTimeout(pageTurnTimeoutRef.current);
      pageTurnTimeoutRef.current = null;
    }
    setCurrentWordIndex(null);
  }, [invalidatePlaybackRun, resetPlaybackRefs, stopPlaybackProjectionLoop]);

  /**
   * Pauses the current audio playback while preserving seek position.
   */
  const pauseActivePlayback = useCallback(() => {
    const audio = unlockedAudioRef.current;
    if (audio) {
      try {
        audio.pause();
      } catch (error) {
        console.warn('Error pausing TTS audio:', error);
      }
    }
    stopPlaybackProjectionLoop();
    stopPlaybackTimelinePolling();

    if (pageTurnTimeoutRef.current) {
      clearTimeout(pageTurnTimeoutRef.current);
      pageTurnTimeoutRef.current = null;
    }

    playbackInFlightRef.current = false;
    setIsProcessing(false);

    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  }, [stopPlaybackProjectionLoop, stopPlaybackTimelinePolling]);

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
    pauseActivePlayback();
    setIsPlaying(false);
  }, [pauseActivePlayback, recordManualPause, clearPendingEpubJump]);

  /**
   * Navigates to a specific location in the document
   * Works for both PDF pages and EPUB locations
   * 
   * @param {string | number} location - The target location to navigate to
   * @param {boolean} shouldPause - Whether to pause playback
   */
  const skipToLocation = useCallback((location: TTSLocation, shouldPause = false) => {
    if (shouldPause) {
      resumeAfterLocationChangeRef.current = false;
    } else if (isPlayingRef.current) {
      resumeAfterLocationChangeRef.current = true;
    }

    // Reset state for new content in correct order
    invalidatePlaybackRun();
    abortAudio(true);
    if (shouldPause) setIsPlaying(false);
    setCurrentIndex(0);
    setSentences([]);
    setPlaybackSegments([]);
    setPlaybackPlanSource('idle');
    playbackAnchorRef.current = null;
    setPlaybackAnchor(null);
    setCurrDocPage(location);

  }, [abortAudio, invalidatePlaybackRun]);

  const prepareInitialPosition = useCallback((location: TTSLocation, sentenceIndex: number) => {
    skipToLocation(location, true);
    pendingJumpTargetRef.current = {
      locationKey: normalizeLocationKey(location),
      index: Math.max(0, Math.floor(sentenceIndex)),
    };
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
      setCurrentIndex(nextIndex);
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
      if (backwards) {
        // Backward navigation breaks forward ordinal continuity.
        lastPlayedCanonicalRef.current = null;
      }
      invalidatePlaybackRun();
      setCurrentIndex(0);
      setSentences([]);
      setPlaybackSegments([]);
      setPlaybackPlanSource('idle');
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
  }, [currentIndex, sentences, isEPUB, invalidatePlaybackRun]);

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
    };
    playbackAnchorRef.current = nextAnchor;
    setPlaybackAnchor(nextAnchor);

    if (handleBlankSection(text.trim())) return;

    const shouldPause = normalizedOptions.shouldPause ?? false;
    const pauseEpochAtStart = pauseEpochRef.current;
    const pendingAutoResume = resumeAfterLocationChangeRef.current;
    const shouldResumePlayback = !shouldPause && (isPlaying || pendingAutoResume);

    // Keep track of previous state and clear the worker-owned playback model.
    // setText now records only the visible document anchor. The worker plan is
    // the single playback and sidebar segment source.
    invalidatePlaybackRun();
    setIsPlaying(false);
    abortAudio(true);
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
      setPlaybackSegments([]);
      setPlaybackPlanSource('idle');
      setSentences([]);
      setCurrentIndex(0);
      if (!pendingEpubLocator && isEPUB) {
        clearPendingEpubJump();
      }
      pendingJumpTargetRef.current = null;

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
    invalidatePlaybackRun,
    currDocPage,
    clearPendingEpubJump,
  ]);

  /**
   * Toggles the playback state between playing and paused
   */
  const togglePlay = useCallback(() => {
    if (isPlaying) {
      recordManualPause();
      clearPendingEpubJump();
      pauseActivePlayback();
      setIsPlaying(false);
      return;
    }

    // Ensure audio is unlocked while we're still in the click/tap handler.
    unlockPlaybackOnUserGesture();

    const audio = unlockedAudioRef.current;
    if (audio && playbackActiveRef.current && audio.src) {
      const headers = playbackRequestHeadersRef.current;
      if (headers) {
        startPlaybackForegroundSync(playbackRunIdRef.current, headers);
      }
      audio.playbackRate = audioSpeed;
      playbackInFlightRef.current = true;
      audio.play()
        .then(() => {
          setIsPlaying(true);
        })
        .catch((error) => {
          console.warn('Error resuming TTS audio:', error);
          playbackInFlightRef.current = false;
          resetPlaybackRefs();
          playbackRequestHeadersRef.current = null;
          setIsPlaying(false);
        });
      return;
    }

    setIsPlaying(true);
  }, [
    audioSpeed,
    isPlaying,
    pauseActivePlayback,
    playbackActiveRef,
    resetPlaybackRefs,
    recordManualPause,
    clearPendingEpubJump,
    startPlaybackForegroundSync,
    unlockPlaybackOnUserGesture,
  ]);


  /**
   * Moves forward one sentence in the text
   */
  const skipForward = useCallback(async () => {
    // Only show processing state if we're currently playing
    if (isPlaying) {
      setIsProcessing(true);
    }
    invalidatePlaybackRun();
    abortAudio(true);
    await advance();
  }, [isPlaying, abortAudio, advance, invalidatePlaybackRun]);

  /**
   * Moves backward one sentence in the text
   */
  const skipBackward = useCallback(async () => {
    // Only show processing state if we're currently playing
    if (isPlaying) {
      setIsProcessing(true);
    }
    invalidatePlaybackRun();
    abortAudio(true);
    await advance(true);
  }, [isPlaying, abortAudio, advance, invalidatePlaybackRun]);

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
    // maxBlockLength/language changes re-shape the canonical plan (new ordinals),
    // so the previous handoff anchor is no longer comparable.
    lastPlayedCanonicalRef.current = null;
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
  }, [audioSpeed]);

  const buildPlaybackSessionRequest = useCallback((): {
    payload: TtsPlaybackSessionPayload;
    headers: TTSRequestHeaders;
    sentence: string;
    playbackSegment: CanonicalTtsSegment | undefined;
    startLocation: { page?: number; spineIndex?: number; charOffset?: number };
  } | null => {
    const playbackSegment = playbackSegments[currentIndex];
    const anchor = playbackAnchorRef.current;
    const sentence = playbackSegment?.text ?? sentences[currentIndex] ?? anchor?.text ?? '';
    if (!documentId) {
      return null;
    }

    const startLocation = activeReaderType === 'pdf'
      ? { page: Math.max(1, Number(anchor?.location ?? currDocPageNumber) || 1) }
      : activeReaderType === 'epub'
        ? (() => {
            const locator = playbackSegment?.ownerLocator
              ?? (isStableEpubLocator(anchor?.locator) ? anchor.locator : null)
              ?? (isStableEpubLocator(pendingEpubJumpRef.current?.locator) ? pendingEpubJumpRef.current.locator : null);
            const spineIndex = Math.max(
              0,
              locator?.spineIndex
                ?? lastPlayedCanonicalRef.current?.spineIndex
                ?? 0,
            );
            const charOffset = typeof locator?.charOffset === 'number' && Number.isFinite(locator.charOffset)
              ? Math.max(0, Math.floor(locator.charOffset))
              : undefined;
            return {
              spineIndex,
              ...(charOffset !== undefined ? { charOffset } : {}),
            };
          })()
        : {};

    const headers: TTSRequestHeaders = {
      'Content-Type': 'application/json',
      'x-tts-provider': configProviderRef,
    };
    return {
      headers,
      sentence,
      playbackSegment,
      startLocation,
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
        startLocation,
        ...(playbackSegment?.key ? { startSegmentKey: playbackSegment.key } : {}),
        ...(sentence.trim() ? { startText: sentence } : {}),
        planning: {
          maxBlockLength: ttsSegmentMaxBlockLength,
          language: resolvedLanguage,
        },
      },
    };
  }, [
    activeReaderType,
    configProviderRef,
    configProviderType,
    currDocPageNumber,
    currentIndex,
    documentId,
    effectiveNativeSpeed,
    playbackSegments,
    providerModelPolicy.supportsInstructions,
    resolvedLanguage,
    sentences,
    ttsInstructions,
    ttsModel,
    ttsSegmentMaxBlockLength,
    voice,
  ]);

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

  const applyPlaybackPlan = useCallback((plan: ReturnType<typeof normalizePlaybackPlan>, request: {
    playbackSegment?: CanonicalTtsSegment;
    sentence: string;
    startLocation: { page?: number; spineIndex?: number; charOffset?: number };
  }) => {
    const canonicalPlan = playbackPlanToCanonicalSegments(plan);
    playbackPlanRef.current = plan;
    playbackSegmentsRef.current = canonicalPlan;
    setPlaybackSegments(canonicalPlan);
    setPlaybackPlanSource('worker');
    setSentences(canonicalPlan.map((segment) => segment.text));
    const startPlanIndex = resolvePlaybackStartIndex({
      plan: canonicalPlan,
      desiredSegment: request.playbackSegment,
      desiredText: request.sentence,
      startLocation: request.startLocation,
    });
    if (currentIndexRef.current !== startPlanIndex) {
      setCurrentIndex(startPlanIndex);
    }
    return { canonicalPlan, startPlanIndex };
  }, [playbackSegmentsRef]);

  const createAndApplyPlaybackPlan = useCallback(async (
    request: ReturnType<typeof buildPlaybackSessionRequest>,
    signal?: AbortSignal,
  ) => {
    if (!request) return null;
    const existing = playbackPlanRef.current;
    if (existing?.planObjectKey && existing.segments.length > 0) return existing;
    const planHandle = await createTtsPlaybackPlan(request.payload, request.headers, signal);
    const plan = await fetchPlaybackPlanUntilReady(planHandle.planUrl, signal);
    if (!plan) return null;
    applyPlaybackPlan(plan, request);
    return plan;
  }, [applyPlaybackPlan, fetchPlaybackPlanUntilReady]);

  useEffect(() => {
    if (isPlaying || playbackPlanSource === 'worker') return;
    if (!playbackAnchor?.text.trim()) return;
    const request = buildPlaybackSessionRequest();
    if (!request) return;

    const controller = new AbortController();
    const runId = ++planPreviewRunIdRef.current;

    void (async () => {
      try {
        const session = await createTtsPlaybackPlan(request.payload, request.headers, controller.signal);
        if (controller.signal.aborted || runId !== planPreviewRunIdRef.current) return;
        const plan = await fetchPlaybackPlanUntilReady(session.planUrl, controller.signal);
        if (controller.signal.aborted || runId !== planPreviewRunIdRef.current || !plan) return;

        applyPlaybackPlan(plan, request);
      } catch (error) {
        if (controller.signal.aborted || isAbortLikeError(error)) return;
        console.warn('Failed to prefetch TTS playback plan:', error);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [
    buildPlaybackSessionRequest,
    applyPlaybackPlan,
    fetchPlaybackPlanUntilReady,
    isAbortLikeError,
    isPlaying,
    playbackAnchor,
    playbackPlanSource,
  ]);

  const playWorkerPlaybackStream = useCallback(async () => {
    const runId = playbackRunIdRef.current;
    const request = buildPlaybackSessionRequest();
    if (!request) {
      playbackInFlightRef.current = false;
      setIsProcessing(false);
      return;
    }
    const { payload, headers, sentence, playbackSegment, startLocation } = request;

    setIsProcessing(true);
    resetPlaybackRefs();
    if (unlockedAudioRef.current) {
      try {
        unlockedAudioRef.current.pause();
        unlockedAudioRef.current.removeAttribute('src');
        unlockedAudioRef.current.load();
      } catch {
        // ignore stale audio teardown
      }
    }

    try {
      const plan = await createAndApplyPlaybackPlan(request);
      if (runId !== playbackRunIdRef.current) return;
      if (!plan?.planObjectKey) {
        throw new Error('TTS playback plan was not ready in time');
      }
      const session = await createTtsPlaybackSession({
        ...payload,
        ...(plan.planId ? { planId: plan.planId } : {}),
        planObjectKey: plan.planObjectKey,
        ...(plan.planSignature ? { planSignature: plan.planSignature } : {}),
        ...(plan.startOrdinal !== undefined ? { startOrdinal: plan.startOrdinal } : {}),
      }, headers);
      if (runId !== playbackRunIdRef.current) return;

      playbackSessionRef.current = {
        sessionId: session.sessionId,
        audioUrl: session.audioUrl,
        timelineUrl: session.timelineUrl,
        seekLayoutUrl: session.seekLayoutUrl,
      };
      playbackRequestHeadersRef.current = headers;

      applyPlaybackPlan(plan, { playbackSegment, sentence, startLocation });
      void getTtsPlaybackSeekLayout(session.seekLayoutUrl)
        .then((layout) => {
          if (runId !== playbackRunIdRef.current) return;
          setPlaybackSeekLayout(layout);
        })
        .catch(() => undefined);

      let audio = unlockedAudioRef.current;
      if (!audio) {
        audio = new Audio();
        audio.preload = 'auto';
        audio.setAttribute('playsinline', 'true');
        unlockedAudioRef.current = audio;
      }
      // Set defaultPlaybackRate as well as playbackRate: the audio.load() below runs
      // the media resource-selection algorithm which resets playbackRate back to
      // defaultPlaybackRate, so without this the first play reverts to 1.0x. The
      // stream is now seekable (range-capable, finite Content-Length), so non-unity
      // rates are honored — including on Safari.
      audio.defaultPlaybackRate = audioSpeed;
      audio.playbackRate = audioSpeed;
      audio.volume = 1;
      audio.onplay = () => {
        if (runId !== playbackRunIdRef.current) return;
        // Re-assert speed: load()'s reset can land after this point, so pin it once
        // playback actually starts.
        audio.playbackRate = audioSpeed;
        startPlaybackProjectionLoop(audio, runId);
        setIsProcessing(false);
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
      };
      audio.onpause = () => {
        if (runId !== playbackRunIdRef.current) return;
        stopPlaybackProjectionLoop();
        playbackInFlightRef.current = false;
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'paused';
        }
      };
      audio.onended = () => {
        if (runId !== playbackRunIdRef.current) return;
        stopPlaybackProjectionLoop();
        playbackInFlightRef.current = false;
        setIsProcessing(false);
        resetPlaybackRefs();
        playbackRequestHeadersRef.current = null;
        if (isPlayingRef.current) {
          void advance();
        }
      };
      audio.onerror = () => {
        if (runId !== playbackRunIdRef.current) return;
        stopPlaybackProjectionLoop();
        playbackInFlightRef.current = false;
        setIsProcessing(false);
        resetPlaybackRefs();
        playbackRequestHeadersRef.current = null;
        setIsPlaying(false);
        toast.error('TTS playback failed. Paused playback.', {
          id: 'tts-playback-error',
          duration: 7000,
        });
      };
      audio.ontimeupdate = () => {
        if (runId !== playbackRunIdRef.current) return;
        // Time advancing means audio is genuinely playing from the buffer, so
        // clear any stale buffering state (e.g. a transient `waiting`).
        setIsProcessing(false);
        setPlaybackTimeSec(audio.currentTime);
        projectPlaybackTime(audio.currentTime);
      };
      // `waiting` means playback actually halted to rebuffer the progressive
      // stream — show loading. `stalled` (slow network while playback continues
      // from the buffer) intentionally does NOT toggle loading: with the single
      // continuous MP3 it fired constantly and stuck the spinner on mid-playback.
      audio.onwaiting = () => {
        if (runId !== playbackRunIdRef.current) return;
        setIsProcessing(true);
      };
      audio.onstalled = null;
      audio.onplaying = () => {
        if (runId !== playbackRunIdRef.current) return;
        startPlaybackProjectionLoop(audio, runId);
        setIsProcessing(false);
      };

      // Foreground sync keeps sidebar/highlights current and heartbeats the
      // cursor while JS is active. Pause stops this layer without destroying the
      // underlying audio session, so resume can reuse the same stream URL.
      startPlaybackForegroundSync(runId, headers);

      playbackActiveRef.current = true;
      audio.src = session.audioUrl;
      audio.load();
      await audio.play();
      if (runId === playbackRunIdRef.current && !audio.paused && !audio.ended) {
        startPlaybackProjectionLoop(audio, runId);
      }
    } catch (error) {
      if (runId !== playbackRunIdRef.current || isAbortLikeError(error)) return;
      console.error('Error playing TTS playback:', error);
      stopPlaybackProjectionLoop();
      playbackInFlightRef.current = false;
      setIsProcessing(false);
      resetPlaybackRefs();
      setIsPlaying(false);
      toast.error('TTS playback failed. Paused playback.', {
        id: 'tts-playback-error',
        duration: 7000,
      });
    }
  }, [
    advance,
    audioSpeed,
    buildPlaybackSessionRequest,
    createAndApplyPlaybackPlan,
    fetchPlaybackPlanUntilReady,
    isAbortLikeError,
    playbackActiveRef,
    playbackSessionRef,
    projectPlaybackTime,
    applyPlaybackPlan,
    resetPlaybackRefs,
    startPlaybackForegroundSync,
    startPlaybackProjectionLoop,
    stopPlaybackProjectionLoop,
  ]);

  /**
   * Main Playback Driver
   * Controls the flow of audio playback and sentence processing
   */
  useEffect(() => {
    if (!isPlaying) {
      playbackInFlightRef.current = false;
      return;
    }
    const hasWorkerSentence = Boolean(sentences[currentIndex]);
    const hasViewportAnchor = Boolean(playbackAnchorRef.current?.text.trim());
    if (!hasWorkerSentence && !hasViewportAnchor) return;
    // Single synchronous guard: covers the async gap between starting playback
    // session and the audio element firing playback events.
    if (playbackInFlightRef.current) return;
    playbackInFlightRef.current = true;

    // Start playing current sentence/window through the worker-owned audio response.
    void playWorkerPlaybackStream();

    return () => {
      // Only abort if we're actually stopping playback
      if (!isPlaying) {
        abortAudio();
      }
    };
  }, [
    isPlaying,
    currentIndex,
    sentences,
    playWorkerPlaybackStream,
    abortAudio
  ]);

  /**
   * Stops the current audio playback and resets all state
   */
  const stop = useCallback(() => {
    // Cancel any ongoing request
    invalidatePlaybackRun();
    abortAudio();
    playbackInFlightRef.current = false;
    pendingJumpTargetRef.current = null;
    clearPendingEpubJump();
    lastPlayedCanonicalRef.current = null;
    setIsPlaying(false);
    setCurrentIndex(0);
    setSentences([]);
    setPlaybackSegments([]);
    setPlaybackPlanSource('idle');
    playbackAnchorRef.current = null;
    setPlaybackAnchor(null);
    setCurrDocPage(1);
    setCurrDocPages(undefined);
    setIsProcessing(false);
    setIsEPUB(false);
    sentenceAlignmentCacheRef.current.clear();
    setCurrentSentenceAlignment(undefined);
    setCurrentWordIndex(null);
  }, [abortAudio, invalidatePlaybackRun, clearPendingEpubJump]);

  const clearSegmentCaches = useCallback(() => {
    // Keep the current viewport/sentence list intact, but force audio state to
    // be re-resolved after a server-side clear.
    abortAudio(true);
    sentenceAlignmentCacheRef.current.clear();
    setCurrentSentenceAlignment(undefined);
    setCurrentWordIndex(null);
  }, [abortAudio]);

  /**
   * Stops the current audio playback and starts playing from a specified index
   * 
   * @param {number} index - The index to start playing from
   */
  const stopAndPlayFromIndex = useCallback((index: number) => {
    invalidatePlaybackRun();
    abortAudio();

    // Same autoplay-unlock issue as togglePlay when starting from a fresh load.
    unlockPlaybackOnUserGesture();

    setCurrentIndex(index);
    setIsPlaying(true);
  }, [abortAudio, invalidatePlaybackRun, unlockPlaybackOnUserGesture]);

  const playFromSegment = useCallback((index: number, locator?: TTSSegmentLocator | null) => {
    if (isEPUB) {
      clearPendingEpubJump();
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
      if (typeof locator.page === 'number' && Number.isFinite(locator.page)) return Math.floor(locator.page);
      return undefined;
    })();

    if (resolvedLocation === undefined && !epubLocatorTarget) {
      stopAndPlayFromIndex(index);
      return;
    }

    const isSameLocation = resolvedLocation !== undefined && typeof resolvedLocation === 'string'
      ? String(currDocPage) === String(resolvedLocation)
      : resolvedLocation !== undefined && Number(currDocPageNumber || 1) === Number(resolvedLocation);

    if (isSameLocation) {
      stopAndPlayFromIndex(index);
      return;
    }

    invalidatePlaybackRun();
    abortAudio();
    unlockPlaybackOnUserGesture();
    if (isEPUB) {
      // CFI snapping makes locationKey unreliable; resolve via epoch on next setText.
      // Carry the target's per-segment charOffset so the canonical window can
      // re-anchor exactly (raw index is viewport-relative to the sidebar).
      pendingEpubJumpRef.current = {
        index: Math.max(0, index),
        epoch: epubJumpEpochRef.current,
        locator: epubLocatorTarget,
      };
      if (epubLocatorTarget) {
        const nextAnchor: PlaybackAnchor = {
          text: playbackSegments[index]?.text ?? '',
          location: epubLocatorTarget.cfi ?? currDocPage,
          locator: epubLocatorTarget,
        };
        playbackAnchorRef.current = nextAnchor;
        setPlaybackAnchor(nextAnchor);
      }
      pendingJumpTargetRef.current = null;
      // A jump breaks ordinal continuity — drop the handoff anchor so the new
      // page plays from its resolved index rather than being trimmed.
      lastPlayedCanonicalRef.current = null;
    } else if (resolvedLocation !== undefined) {
      pendingJumpTargetRef.current = {
        locationKey: normalizeLocationKey(resolvedLocation),
        index: Math.max(0, index),
      };
    }
    resumeAfterLocationChangeRef.current = true;
    setCurrentIndex(0);
    setIsPlaying(true);
    if (isEPUB && locationChangeHandlerRef.current) {
      locationChangeHandlerRef.current(epubLocatorTarget ?? resolvedLocation!);
      return;
    }
    if (resolvedLocation !== undefined) {
      skipToLocation(resolvedLocation, false);
    }
  }, [
    stopAndPlayFromIndex,
    currDocPage,
    currDocPageNumber,
    isEPUB,
    invalidatePlaybackRun,
    abortAudio,
    unlockPlaybackOnUserGesture,
    skipToLocation,
    clearPendingEpubJump,
  ]);

  const seekPlaybackTo = useCallback((seconds: number) => {
    const layout = playbackSeekLayout;
    if (!layout || layout.segments.length === 0) return;
    const durationSec = Math.max(0, layout.durationMs / 1000);
    const targetSec = Math.max(0, Math.min(seconds, durationSec));
    const targetMs = targetSec * 1000;
    const target = layout.segments.find((segment) => targetMs >= segment.startMs && targetMs < segment.endMs)
      ?? layout.segments[layout.segments.length - 1];
    if (!target) return;

    const audio = unlockedAudioRef.current;
    if (audio && playbackActiveRef.current && audio.src) {
      try {
        audio.currentTime = targetSec;
      } catch {
        // Best-effort; the projection still updates immediately below.
      }
    }
    setPlaybackTimeSec(targetSec);
    const nextIndex = playbackSegmentsRef.current.findIndex((segment) =>
      (target.segmentKey && segment.key === target.segmentKey) || segment.ordinal === target.ordinal
    );
    if (nextIndex >= 0 && currentIndexRef.current !== nextIndex) {
      setCurrentIndex(nextIndex);
    }
    projectPlaybackTime(targetSec);
    const session = playbackSessionRef.current;
    const headers = playbackRequestHeadersRef.current;
    if (session && headers) {
      void postTtsPlaybackCursor(session.sessionId, target.ordinal, headers);
    }
  }, [
    playbackActiveRef,
    playbackSeekLayout,
    playbackSessionRef,
    projectPlaybackTime,
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
    abortAudio(true); // Clear pending requests since speed changed

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
  }, [abortAudio, updateConfigKey, isPlaying, clearPendingEpubJump]);

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
    abortAudio(true); // Clear pending requests since voice changed

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
  }, [abortAudio, updateConfigKey, isPlaying, clearPendingEpubJump]);

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
    abortAudio(true); // Clear pending requests since speed changed

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
   * Provides the TTS context value to child components
   */
  const value = useMemo(() => ({
    isPlaying,
    isProcessing,
    currentSentence: sentences[currentIndex] || '',
    currentSegment: playbackSegments[currentIndex] ?? null,
    sentences,
    playbackSegments,
    playbackPlanSource,
    currentSentenceIndex: currentIndex,
    playbackTimeSec,
    playbackDurationSec: playbackSeekLayout ? playbackSeekLayout.durationMs / 1000 : 0,
    playbackSeekLayout,
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
    stopAndPlayFromIndex,
    playFromSegment,
    seekPlaybackTo,
    setText,
    setCurrDocPages,
    setSpeedAndRestart,
    setAudioPlayerSpeedAndRestart,
    setVoiceAndRestart,
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
    sentences,
    playbackSegments,
    playbackPlanSource,
    playbackSeekLayout,
    playbackTimeSec,
    currentIndex,
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
    stopAndPlayFromIndex,
    playFromSegment,
    seekPlaybackTo,
    setText,
    setCurrDocPages,
    setSpeedAndRestart,
    setAudioPlayerSpeedAndRestart,
    setVoiceAndRestart,
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

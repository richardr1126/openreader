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
  createTtsPlaybackSession,
  postTtsPlaybackCursor,
  subscribeTtsPlaybackEvents,
} from '@/lib/client/api/tts';
import {
  normalizePlaybackPlan,
  playbackPlanToCanonicalSegments,
} from '@/lib/client/tts/playback-plan';
import { preprocessSentenceForAudio } from '@openreader/tts/nlp';
import {
  buildSegmentKeyPrefix,
  planCanonicalTtsSegments,
  type CanonicalTtsSegment,
  type CanonicalTtsSourceUnit,
} from '@openreader/tts/segment-plan';
import {
  completedEpubBoundarySegment,
  resolveEpubBoundaryHandoffStartIndex,
  resolveEpubReplaySuppressionAction,
  type CompletedEpubBoundarySegment,
} from '@/lib/client/epub/tts-epub-handoff';
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
  currentSentenceIndex: number;

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
  registerLocationChangeHandler: (handler: ((location: TTSLocation) => void) | null) => void;  // EPUB-only: Handles chapter navigation
  setIsEPUB: (isEPUB: boolean) => void;
  /** Effective reader type used to mint segmentKeys (see buildSegmentKeyPrefix). */
  activeReaderType: ReaderType;
}

interface SetTextOptions {
  shouldPause?: boolean;
  location?: TTSLocation;
  sourceUnits?: CanonicalTtsSourceUnit[];
  /**
   * EPUB canonical path: pre-windowed segments for the current page, sliced
   * from the chapter's single canonical plan (stable key + global `ordinal`).
   * When present, setText uses them verbatim and skips preview-based planning.
   */
  canonicalSegments?: CanonicalTtsSegment[];
  /** Spine identity of `canonicalSegments`, for the ordinal-continuity gate. */
  canonicalSpine?: { spineHref: string; spineIndex: number };
}

type TTSPendingJumpTarget = {
  locationKey: string;
  index: number;
};

type JumpResolutionInput = {
  isEPUB: boolean;
  newSentenceCount: number;
  resolvedLocationKey: string;
  pendingEpubJump: { index: number; epoch: number } | null;
  currentEpubEpoch: number;
  pendingStrictJump: { locationKey: string; index: number } | null;
};

type JumpResolution =
  | { kind: 'epub-resolved'; index: number }
  | { kind: 'strict-resolved'; index: number }
  | { kind: 'fresh' };

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
  startLocation: { page?: number; spineIndex?: number },
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
  startLocation: { page?: number; spineIndex?: number };
}): number => {
  if (input.plan.length === 0) return 0;
  if (input.desiredSegment?.key) {
    const byKey = input.plan.findIndex((segment) => segment.key === input.desiredSegment!.key);
    if (byKey >= 0) return byKey;
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

const resolveJumpIndex = (input: JumpResolutionInput): JumpResolution => {
  if (input.newSentenceCount <= 0) {
    return { kind: 'fresh' };
  }
  const clamp = (raw: number): number =>
    Math.max(0, Math.min(raw, input.newSentenceCount - 1));

  if (
    input.isEPUB
    && input.pendingEpubJump
    && input.pendingEpubJump.epoch === input.currentEpubEpoch
  ) {
    return { kind: 'epub-resolved', index: clamp(input.pendingEpubJump.index) };
  }

  if (
    input.pendingStrictJump
    && input.pendingStrictJump.locationKey === input.resolvedLocationKey
  ) {
    return { kind: 'strict-resolved', index: clamp(input.pendingStrictJump.index) };
  }

  return { kind: 'fresh' };
};

/**
 * Resolve the local start index for an EPUB canonical-window page using ordinal
 * continuity. The window's segments carry chapter-global `ordinal`s; we begin at
 * the first one past the highest ordinal already spoken in this same spine item.
 *
 * Only trims on a *forward, contiguous* turn — when the window overlaps or sits
 * just after what we've played. A backward turn or a non-contiguous jump returns
 * 0 (play the whole window from the top); a different spine item returns 0.
 */
const resolveCanonicalStartIndex = (
  segments: CanonicalTtsSegment[],
  spine: { spineHref: string; spineIndex: number } | null,
  lastPlayed: { spineHref: string; spineIndex: number; ordinal: number } | null,
): number => {
  if (segments.length === 0) return 0;
  if (!spine || !lastPlayed) return 0;
  if (lastPlayed.spineHref !== spine.spineHref || lastPlayed.spineIndex !== spine.spineIndex) return 0;

  const windowStart = segments[0].ordinal;
  const windowEnd = segments[segments.length - 1].ordinal;
  if (windowStart > lastPlayed.ordinal + 1) return 0; // jumped ahead → play whole window
  if (windowEnd < lastPlayed.ordinal) return 0;        // moved backward → play whole window

  const idx = segments.findIndex((segment) => segment.ordinal > lastPlayed.ordinal);
  return idx < 0 ? segments.length : idx;
};

const sourceKeyForLocation = (location: TTSLocation | undefined, fallback: TTSLocation): string =>
  normalizeLocationKey(location ?? fallback);

const locatorForLocation = (
  location: TTSLocation,
  readerType: ReaderType,
): TTSSegmentLocator => {
  if (typeof location === 'string') {
    return { location, readerType };
  }
  if (readerType === 'html') {
    return { location: String(location || 1), readerType };
  }
  return { page: Math.max(1, Math.floor(Number(location || 1))), readerType };
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
  const locationChangeHandlerRef = useRef<((location: TTSLocation) => void) | null>(null);

  /**
   * Registers a handler function for location changes in EPUB documents
   * This is only used for EPUB documents to handle chapter navigation
   *
   * @param {Function} handler - Function to handle location changes
   */
  const registerLocationChangeHandler = useCallback((handler: ((location: TTSLocation) => void) | null) => {
    locationChangeHandlerRef.current = handler;
  }, []);

  /**
   * State Management
   */
  const [isPlaying, setIsPlaying] = useState(false);
  const [isEPUB, setIsEPUB] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  /**
   * Resolved reader type for segment planning. Mirrors the `activeReaderType`
   * used inside `setText` so external consumers (e.g. the
   * sidebar) can compute identical `segmentKey`s from local text and match
   * them against persisted manifest rows by content identity.
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
  const pendingEpubJumpRef = useRef<{ index: number; epoch: number; charOffset?: number } | null>(null);
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
  const pendingPlaybackStartRef = useRef(false);
  const sentencesRef = useRef<string[]>([]);
  const currentIndexRef = useRef(0);
  const completedEpubBoundarySegmentRef = useRef<CompletedEpubBoundarySegment | null>(null);
  // Highest canonical segment ordinal already spoken in the current spine item.
  // Drives exact, viewport-independent page-turn handoff: the next page begins
  // at the first window segment whose ordinal exceeds this. Replaces fuzzy
  // fingerprint matching for within-chapter turns (the spine→spine handoff in
  // tts-epub-handoff.ts remains the fallback path's safety net).
  const lastPlayedCanonicalRef = useRef<{ spineHref: string; spineIndex: number; ordinal: number } | null>(null);
  const audioUnlockAttemptRef = useRef(0);
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

  /**
   * Stops the current audio playback and optionally clears pending requests.
   */
  const abortAudio = useCallback((clearPending = false) => {
    // Ensure next playback attempt is not blocked by a stale in-flight guard.
    invalidatePlaybackRun();
    resetPlaybackRefs();
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
  }, [invalidatePlaybackRun, resetPlaybackRefs]);

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

    if (pageTurnTimeoutRef.current) {
      clearTimeout(pageTurnTimeoutRef.current);
      pageTurnTimeoutRef.current = null;
    }

    playbackInFlightRef.current = false;
    setIsProcessing(false);

    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  }, []);

  const recordManualPause = useCallback(() => {
    // Cancel any queued auto-resume intent and mark an explicit user pause.
    resumeAfterLocationChangeRef.current = false;
    pendingPlaybackStartRef.current = false;
    pauseEpochRef.current += 1;
  }, []);

  /**
   * Pauses the current audio playback
   * Used for external control of playback state
   */
  const pause = useCallback(() => {
    pendingPlaybackStartRef.current = false;
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
   * Sets the current text and splits it into sentences
   * 
   * @param {string} text - The text to be processed
   */
  const setText = useCallback((text: string, options?: boolean | SetTextOptions) => {
    const normalizedOptions: SetTextOptions = typeof options === 'boolean'
      ? { shouldPause: options }
      : (options || {});

    const resolvedLocation = normalizedOptions.location !== undefined
      ? normalizedOptions.location
      : currDocPage;
    const resolvedLocationKey = normalizeLocationKey(resolvedLocation);
    const currentUnits = normalizedOptions.sourceUnits && normalizedOptions.sourceUnits.length > 0
      ? normalizedOptions.sourceUnits
      : null;

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
    const currentSourceKey = sourceKeyForLocation(resolvedLocation, currDocPage);
    const currentSource: CanonicalTtsSourceUnit = {
      sourceKey: currentSourceKey,
      text,
      locator: locatorForLocation(resolvedLocation, activeReaderType),
    };
    const effectiveCurrentUnits = currentUnits && currentUnits.length > 0 ? currentUnits : [currentSource];
    const currentSourceKeySet = new Set(effectiveCurrentUnits.map((unit) => unit.sourceKey));

    // EPUB canonical path: the caller already windowed this page out of the
    // chapter's single canonical plan, so we use those segments verbatim and
    // skip preview-based planning entirely. This is what makes a page-straddling
    // block identical (same key + global ordinal) on both pages.
    const useCanonicalEpub = isEPUB
      && Array.isArray(normalizedOptions.canonicalSegments)
      && normalizedOptions.canonicalSegments.length > 0;

    let currentSegments: CanonicalTtsSegment[];
    let newSentences: string[];

    if (useCanonicalEpub) {
      currentSegments = normalizedOptions.canonicalSegments!;
      newSentences = currentSegments.map((segment) => segment.text);
    } else {
      const plan = planCanonicalTtsSegments(effectiveCurrentUnits, {
        readerType: activeReaderType,
        maxBlockLength: ttsSegmentMaxBlockLength,
        keyPrefix: buildSegmentKeyPrefix(documentId, activeReaderType),
        enforceSourceBoundaries: activeReaderType === 'pdf' && currentUnits !== null && currentUnits.length > 0,
        language: resolvedLanguage,
      });
      currentSegments = plan.segments.filter((segment) => currentSourceKeySet.has(segment.ownerSourceKey));
      newSentences = currentSegments.map((segment) => segment.text);
    }

    if (handleBlankSection(newSentences.join(' '))) return;

    const shouldPause = normalizedOptions.shouldPause ?? false;
    const pauseEpochAtStart = pauseEpochRef.current;
    const pendingAutoResume = resumeAfterLocationChangeRef.current;
    const pendingPlaybackStart = pendingPlaybackStartRef.current;
    const shouldResumePlayback = !shouldPause && (isPlaying || pendingAutoResume || pendingPlaybackStart);

    // Keep track of previous state and pause playback
    invalidatePlaybackRun();
    setIsPlaying(false);
    abortAudio(true); // Clear pending requests since text is changing
    setIsProcessing(true); // Set processing state before text processing starts

    try {
      if (newSentences.length === 0) {
        console.warn('No sentences found in text');
        if (shouldPause || pendingAutoResume) {
          resumeAfterLocationChangeRef.current = false;
        }
        if (pendingPlaybackStart) {
          pendingPlaybackStartRef.current = false;
        }
        setIsProcessing(false);
        return;
      }

      if (shouldPause || pendingAutoResume) {
        resumeAfterLocationChangeRef.current = false;
      }
      if (pendingPlaybackStart) {
        pendingPlaybackStartRef.current = false;
      }

      setPlaybackSegments(currentSegments);
      setSentences(newSentences);

      const resolution = resolveJumpIndex({
        isEPUB,
        newSentenceCount: newSentences.length,
        resolvedLocationKey,
        pendingEpubJump: pendingEpubJumpRef.current,
        currentEpubEpoch: epubJumpEpochRef.current,
        pendingStrictJump: pendingJumpTargetRef.current,
      });
      let startIndex = 0;
      if (resolution.kind === 'epub-resolved') {
        startIndex = resolution.index;
        // Cross-page jump hardening: the raw index was computed against the
        // sidebar's view. On the canonical path, re-anchor to the segment whose
        // per-segment charOffset matches the jump target so chapters with
        // repeated text land exactly.
        const jump = pendingEpubJumpRef.current;
        if (useCanonicalEpub && jump && typeof jump.charOffset === 'number') {
          const mapped = currentSegments.findIndex(
            (segment) => segment.ownerLocator?.charOffset === jump.charOffset,
          );
          if (mapped >= 0) startIndex = mapped;
        }
        setCurrentIndex(startIndex);
        pendingEpubJumpRef.current = null;
        pendingJumpTargetRef.current = null;
      } else if (resolution.kind === 'strict-resolved') {
        startIndex = resolution.index;
        setCurrentIndex(startIndex);
        pendingJumpTargetRef.current = null;
      } else {
        if (isEPUB) {
          clearPendingEpubJump();
        }
        if (useCanonicalEpub && shouldResumePlayback) {
          // Exact ordinal handoff: start at the first window segment past the
          // highest ordinal already spoken in this chapter.
          startIndex = resolveCanonicalStartIndex(
            currentSegments,
            normalizedOptions.canonicalSpine ?? null,
            lastPlayedCanonicalRef.current,
          );
        } else if (isEPUB && shouldResumePlayback) {
          startIndex = resolveEpubBoundaryHandoffStartIndex(currentSegments, completedEpubBoundarySegmentRef.current);
          if (startIndex > 0) {
            completedEpubBoundarySegmentRef.current = null;
          }
        } else {
          startIndex = 0;
        }
        setCurrentIndex(startIndex);
      }

      sentenceAlignmentCacheRef.current.clear();
      setCurrentSentenceAlignment(undefined);
      setCurrentWordIndex(null);

      setIsProcessing(false);

      if (shouldResumePlayback && startIndex >= newSentences.length) {
        setIsPlaying(false);
        return;
      }

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
    invalidatePlaybackRun,
    currDocPage,
    documentId,
    ttsSegmentMaxBlockLength,
    resolvedLanguage,
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

    const hasPreparedSentence = Boolean(playbackSegments[currentIndex]?.text ?? sentences[currentIndex]);
    if (!hasPreparedSentence) {
      pendingPlaybackStartRef.current = true;
      setIsProcessing(true);
      return;
    }

    const audio = unlockedAudioRef.current;
    if (audio && playbackActiveRef.current && audio.src) {
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
          setIsPlaying(false);
        });
      return;
    }

    setIsPlaying(true);
  }, [
    audioSpeed,
    currentIndex,
    isPlaying,
    pauseActivePlayback,
    playbackSegments,
    playbackActiveRef,
    resetPlaybackRefs,
    recordManualPause,
    clearPendingEpubJump,
    sentences,
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

  const playWorkerPlaybackStream = useCallback(async () => {
    const runId = playbackRunIdRef.current;
    const playbackSegment = playbackSegments[currentIndex];
    const sentence = playbackSegment?.text ?? sentences[currentIndex];
    if (!sentence || !documentId) {
      playbackInFlightRef.current = false;
      setIsProcessing(false);
      return;
    }

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
      // Worker-owned planning: send only the current reading position; the
      // worker derives reading text from the document itself and generates the
      // configured extent (section/document) ahead, independent of this client.
      const startLocation = activeReaderType === 'pdf'
        ? { page: Math.max(1, Number(currDocPageNumber) || 1) }
        : activeReaderType === 'epub'
          ? {
              spineIndex: Math.max(
                0,
                playbackSegment?.ownerLocator?.spineIndex
                  ?? lastPlayedCanonicalRef.current?.spineIndex
                  ?? 0,
              ),
            }
          : {};

      const headers: TTSRequestHeaders = {
        'Content-Type': 'application/json',
        'x-tts-provider': configProviderRef,
      };
      const session = await createTtsPlaybackSession({
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
        startText: sentence,
        planning: {
          maxBlockLength: ttsSegmentMaxBlockLength,
          language: resolvedLanguage,
        },
      }, headers);
      if (runId !== playbackRunIdRef.current) return;

      playbackSessionRef.current = {
        sessionId: session.sessionId,
        audioUrl: session.audioUrl,
        timelineUrl: session.timelineUrl,
      };

      // Fetch the worker's canonical plan (full ordered segments + text) and
      // make it the playback model so currentIndex/sidebar/highlighting are
      // driven by the worker, not per-page client planning.
      const fetchPlan = async () => {
        const res = await fetch(session.planUrl, { cache: 'no-store' });
        if (!res.ok) return null;
        return normalizePlaybackPlan(await res.json());
      };
      let plan = await fetchPlan();
      for (let attempt = 0; (!plan || plan.segments.length === 0) && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (runId !== playbackRunIdRef.current) return;
        plan = await fetchPlan();
      }
      if (!plan || plan.segments.length === 0) {
        throw new Error('TTS playback plan was not ready in time');
      }
      const canonicalPlan = playbackPlanToCanonicalSegments(plan);
      playbackSegmentsRef.current = canonicalPlan;
      setPlaybackSegments(canonicalPlan);
      setSentences(canonicalPlan.map((segment) => segment.text));

      // Resolve the starting index within the worker plan. Prefer the exact
      // segment key, then fall back to normalized visible text at the requested
      // page/spine so startup does not jump to segment zero when local and
      // worker planning disagree on key shape.
      const startPlanIndex = resolvePlaybackStartIndex({
        plan: canonicalPlan,
        desiredSegment: playbackSegment,
        desiredText: sentence,
        startLocation,
      });
      if (runId !== playbackRunIdRef.current) return;
      if (currentIndexRef.current !== startPlanIndex) {
        setCurrentIndex(startPlanIndex);
      }

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
        setIsProcessing(false);
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
      };
      audio.onpause = () => {
        if (runId !== playbackRunIdRef.current) return;
        playbackInFlightRef.current = false;
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'paused';
        }
      };
      audio.onended = () => {
        if (runId !== playbackRunIdRef.current) return;
        playbackInFlightRef.current = false;
        setIsProcessing(false);
        resetPlaybackRefs();
        if (isPlayingRef.current) {
          void advance();
        }
      };
      audio.onerror = () => {
        if (runId !== playbackRunIdRef.current) return;
        playbackInFlightRef.current = false;
        setIsProcessing(false);
        resetPlaybackRefs();
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
        setIsProcessing(false);
      };

      stopPlaybackTimelinePolling();
      void refreshPlaybackTimeline(session.timelineUrl).catch(() => undefined);
      playbackEventsUnsubRef.current = subscribeTtsPlaybackEvents(session.sessionId, {
        onSnapshot: (snapshot) => {
          if (runId !== playbackRunIdRef.current) return;
          if (snapshot.status === 'failed') return;
          const activeSession = playbackSessionRef.current;
          if (!activeSession) return;
          void refreshPlaybackTimeline(activeSession.timelineUrl)
            .catch(() => undefined);
        },
      });

      // Heartbeat the playback cursor so the worker throttles generation to a
      // window ahead of the listener while connected, and continues to the admin
      // background extent once these stop (JS suspended / tab closed). It posts
      // on every tick (not just on advance) so the worker's freshness check sees
      // an actively-read session even mid-segment.
      const writeCursor = () => {
        const activeSession = playbackSessionRef.current;
        if (!activeSession) return;
        const cursor = Math.max(0, currentIndexRef.current);
        void postTtsPlaybackCursor(activeSession.sessionId, cursor, headers);
      };
      writeCursor();
      playbackCursorIntervalRef.current = setInterval(() => {
        if (runId !== playbackRunIdRef.current) return;
        writeCursor();
      }, TTS_PLAYBACK_CURSOR_HEARTBEAT_MS);

      playbackActiveRef.current = true;
      audio.src = session.audioUrl;
      audio.load();
      await audio.play();
    } catch (error) {
      if (runId !== playbackRunIdRef.current || isAbortLikeError(error)) return;
      console.error('Error playing TTS playback:', error);
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
    activeReaderType,
    advance,
    audioSpeed,
    configProviderRef,
    configProviderType,
    currDocPageNumber,
    currentIndex,
    documentId,
    effectiveNativeSpeed,
    isAbortLikeError,
    playbackSegments,
    playbackActiveRef,
    playbackCursorIntervalRef,
    playbackEventsUnsubRef,
    playbackSessionRef,
    projectPlaybackTime,
    providerModelPolicy.supportsInstructions,
    refreshPlaybackTimeline,
    resetPlaybackRefs,
    resolvedLanguage,
    sentences,
    stopPlaybackTimelinePolling,
    ttsSegmentMaxBlockLength,
    ttsInstructions,
    ttsModel,
    voice,
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
    if (!sentences[currentIndex]) return; // Don't proceed if no sentence to play
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
    pendingPlaybackStartRef.current = false;
    pendingJumpTargetRef.current = null;
    clearPendingEpubJump();
    completedEpubBoundarySegmentRef.current = null;
    lastPlayedCanonicalRef.current = null;
    setIsPlaying(false);
    setCurrentIndex(0);
    setSentences([]);
    setPlaybackSegments([]);
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

    const resolvedLocation: TTSLocation | undefined = (() => {
      if (!locator) return undefined;
      // Stable EPUB locators carry the jump-hint CFI in `cfi`, not `location`
      // (which is now reserved for HTML / legacy rows).
      if (locator.readerType === 'epub' && typeof locator.cfi === 'string' && locator.cfi) {
        return locator.cfi;
      }
      if (typeof locator.location === 'string' && locator.location) return locator.location;
      if (typeof locator.page === 'number' && Number.isFinite(locator.page)) return Math.floor(locator.page);
      return undefined;
    })();

    if (resolvedLocation === undefined) {
      stopAndPlayFromIndex(index);
      return;
    }

    const isSameLocation = typeof resolvedLocation === 'string'
      ? String(currDocPage) === String(resolvedLocation)
      : Number(currDocPageNumber || 1) === Number(resolvedLocation);

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
        charOffset: typeof locator?.charOffset === 'number' ? locator.charOffset : undefined,
      };
      pendingJumpTargetRef.current = null;
      // A jump breaks ordinal continuity — drop the handoff anchor so the new
      // page plays from its resolved index rather than being trimmed.
      lastPlayedCanonicalRef.current = null;
    } else {
      pendingJumpTargetRef.current = {
        locationKey: normalizeLocationKey(resolvedLocation),
        index: Math.max(0, index),
      };
    }
    resumeAfterLocationChangeRef.current = true;
    setCurrentIndex(0);
    setIsPlaying(true);
    if (isEPUB && locationChangeHandlerRef.current) {
      locationChangeHandlerRef.current(resolvedLocation);
      return;
    }
    skipToLocation(resolvedLocation, false);
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
    currentSentenceIndex: currentIndex,
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

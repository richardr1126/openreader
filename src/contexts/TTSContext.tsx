/**
 * Text-to-Speech (TTS) Context Provider
 * 
 * This module provides a React context for managing text-to-speech functionality.
 * It handles audio playback, sentence processing, and integration with OpenAI's TTS API.
 * 
 * Key features:
 * - Audio playback control (play/pause/skip)
 * - Sentence-by-sentence processing
 * - Audio caching for better performance
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
import { Howl } from 'howler';
import toast from 'react-hot-toast';
import { useParams, usePathname } from 'next/navigation';

import { useConfig } from '@/contexts/ConfigContext';
import { useVoiceManagement } from '@/hooks/audio/useVoiceManagement';
import { useMediaSession } from '@/hooks/audio/useMediaSession';
import { useAudioContext } from '@/hooks/audio/useAudioContext';
import { getLastDocumentLocation, setLastDocumentLocation } from '@/lib/client/dexie';
import { getDocumentProgress, scheduleDocumentProgressSync } from '@/lib/client/api/user-state';
import { withRetry, ensureTtsSegments } from '@/lib/client/api/audiobooks';
import { preprocessSentenceForAudio } from '@/lib/shared/nlp';
import {
  buildSegmentKeyPrefix,
  planCanonicalTtsSegments,
  type CanonicalTtsSegment,
  type CanonicalTtsSourceUnit,
} from '@/lib/shared/tts-segment-plan';
import {
  buildWalkerPlanningSourceUnits,
  selectUpcomingWalkerItems,
} from '@/lib/client/epub/tts-epub-preload';
import {
  releaseWarmAudio,
  upsertWarmAudioEntry,
  type WarmAudioCacheEntry,
} from '@/lib/client/tts/audio-warm-cache';
import {
  isRetryableSegmentStatus,
  resolveSegmentStatusRetryDelayMs,
  shouldDeferSegmentRetry,
} from '@/lib/client/tts/segment-retry-policy';
import {
  completedEpubBoundarySegment,
  resolveEpubBoundaryHandoffStartIndex,
  resolveEpubReplaySuppressionAction,
  type CompletedEpubBoundarySegment,
} from '@/lib/client/epub/tts-epub-handoff';
import { normalizeTtsLocationKey } from '@/lib/shared/tts-locator';
import { resolveTtsProviderModelPolicy } from '@/lib/shared/tts-provider-policy';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import type {
  EpubRenderedLocationWalker,
  TTSLocation,
  TTSPageTurnEstimate,
  TTSPlaybackState,
  TTSSentenceAlignment,
} from '@/types/tts';
import type {
  TTSRequestHeaders,
  TTSSegmentInput,
  TTSSegmentLocator,
  TTSRetryOptions,
  TTSSegmentManifestItem,
} from '@/types/client';
import { isStableEpubLocator } from '@/types/client';

/**
 * Resolves an EPUB segment's draft locator (typically `{ readerType: 'epub',
 * location: <CFI> }`) into a stable book coordinate. The resolver lives in
 * the route-local EPUB reader hook where the live `Book` instance is available; TTSContext calls it
 * just before posting segments to the server so what gets persisted is
 * viewport-independent. Returns null when the CFI can't be resolved.
 */
export type EpubLocatorResolver = (
  draft: TTSSegmentLocator,
  segmentText: string,
  options?: {
    segmentIndex: number;
    segmentKey?: string | null;
    keyPrefix: string;
    maxBlockLength: number;
  },
) => Promise<{
  locator: TTSSegmentLocator;
  segmentKey?: string | null;
  segmentIndex?: number;
  text?: string;
} | null>;
import type { ReaderType } from '@/types/user-state';
import {
  clampSegmentPreloadDepth,
  clampSegmentPreloadSentenceLookahead,
} from '@/types/config';

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
  clearSegmentCaches: () => void;
  skipToLocation: (location: TTSLocation, shouldPause?: boolean) => void;
  registerLocationChangeHandler: (handler: ((location: TTSLocation) => void) | null) => void;  // EPUB-only: Handles chapter navigation
  registerEpubLocationWalker: (walker: EpubRenderedLocationWalker | null) => void;
  registerEpubLocatorResolver: (resolver: EpubLocatorResolver | null) => void;  // EPUB-only: resolves CFI drafts to stable spine coords before persist
  registerVisualPageChangeHandler: (handler: ((location: TTSLocation) => void) | null) => void;
  setIsEPUB: (isEPUB: boolean) => void;
  /** Effective reader type used to mint segmentKeys (see buildSegmentKeyPrefix). */
  activeReaderType: ReaderType;
}

interface SetTextOptions {
  shouldPause?: boolean;
  location?: TTSLocation;
  sourceUnits?: CanonicalTtsSourceUnit[];
  previousLocation?: TTSLocation;
  nextLocation?: TTSLocation;
  nextText?: string;
  nextSourceUnits?: CanonicalTtsSourceUnit[];
  previousText?: string;
  upcomingLocations?: Array<{ location: TTSLocation; text: string; sourceUnits?: CanonicalTtsSourceUnit[] }>;
}

type TTSSegmentPlaybackSource = {
  presignUrl: string;
  fallbackUrl: string;
  manifest: TTSSegmentManifestItem;
};

type TTSPendingJumpTarget = {
  locationKey: string;
  index: number;
};

type EpubLocationPreloadCandidate = {
  sentence: string;
  segmentKey: string;
  segmentIndex: number;
  location: string;
  requestKey: string;
  cacheKey: string;
};

type PersistResolution = {
  segments: TTSSegmentInput[];
  sourceIndices: number[];
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

const LOOP_GUARD_MIN_INDEX = 2;
const LOOP_GUARD_MIN_PROGRESS = 0.6;
const AUDIO_CACHE_MAX_ITEMS = 25;
const WARM_AUDIO_CACHE_MAX_ITEMS = 6;
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

const normalizeBlockFingerprint = (text: string): string => {
  const normalized = preprocessSentenceForAudio(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.slice(0, 200);
};

const buildCacheKey = (
  sentence: string,
  voice: string,
  speed: number,
  provider: string,
  model: string,
  providerType: string,
  instructions: string,
) => {
  return [
    `provider=${provider || ''}`,
    `providerType=${providerType || ''}`,
    `model=${model || ''}`,
    `voice=${voice || ''}`,
    `speed=${Number.isFinite(speed) ? speed : ''}`,
    `instructions=${instructions || ''}`,
    `text=${sentence}`,
  ].join('|');
};

const buildScopedSegmentCacheKey = (
  locator: TTSSegmentLocator,
  segmentIndex: number,
  sentence: string,
  voice: string,
  speed: number,
  provider: string,
  model: string,
  providerType: string,
  instructions: string,
  segmentKey?: string | null,
) => {
  return [
    buildCacheKey(sentence, voice, speed, provider, model, providerType, instructions),
    `segmentKey=${segmentKey || ''}`,
    `locator=${segmentKey ? '' : buildLocatorRequestKey(locator)}`,
    `segmentIndex=${segmentKey ? '' : segmentIndex}`,
  ].join('|');
};

const buildLocatorRequestKey = (locator: TTSSegmentLocator): string => {
  // Stable EPUB locators: use spine identity + charOffset for a unique,
  // viewport-independent cache key. Falling through to `locator.location`
  // would yield the empty string for the new shape and collide across
  // segments.
  if (locator.readerType === 'epub') {
    if (
      typeof locator.spineHref === 'string'
      && typeof locator.spineIndex === 'number'
      && typeof locator.charOffset === 'number'
    ) {
      return `epub:${locator.spineIndex}:${locator.spineHref}:${locator.charOffset}`;
    }
    if (typeof locator.cfi === 'string' && locator.cfi) {
      return normalizeLocationKey(locator.cfi);
    }
  }
  if (typeof locator.location === 'string' && locator.location) {
    return normalizeLocationKey(locator.location);
  }
  if (locator.readerType === 'pdf') {
    const page = Number(locator.page || 1);
    const block = typeof locator.blockId === 'string' && locator.blockId ? locator.blockId : '';
    return normalizeLocationKey(`pdf:${page}:${block}`);
  }
  return normalizeLocationKey(Number(locator.page || 1));
};

const buildSegmentRequestKey = (
  locator: TTSSegmentLocator,
  segmentIndex: number,
  sentence: string,
  segmentKey?: string | null,
): string => {
  return segmentKey
    ? `${segmentKey}::${sentence}`
    : `${buildLocatorRequestKey(locator)}::${segmentIndex}::${sentence}`;
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
 * Handles initialization of OpenAI client, audio context, and media session.
 * 
 * @param {Object} props - Component props
 * @param {ReactNode} props.children - Child components to be wrapped by the provider
 * @returns {JSX.Element} TTSProvider component
 */
export function TTSProvider({ children }: { children: ReactNode }): ReactElement {
  // Configuration context consumption
  const {
    apiKey: openApiKey,
    baseUrl: openApiBaseUrl,
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
    segmentPreloadDepthPages,
    segmentPreloadSentenceLookahead,
    ttsSegmentMaxBlockLength,
    pdfHighlightEnabled,
    pdfWordHighlightEnabled,
    epubHighlightEnabled,
    epubWordHighlightEnabled,
  } = useConfig();

  // Audio and voice management hooks
  const audioContext = useAudioContext();
  const { availableVoices, fetchVoices } = useVoiceManagement(
    openApiKey,
    openApiBaseUrl,
    configProviderRef,
    configProviderType,
    configTTSModel,
  );
  const {
    onTTSStart,
    onTTSComplete,
    refresh: refreshRateLimit,
    triggerRateLimit,
    isAtLimit,
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
  const visualPageChangeHandlerRef = useRef<((location: TTSLocation) => void) | null>(null);

  /**
   * Registers a handler function for location changes in EPUB documents
   * This is only used for EPUB documents to handle chapter navigation
   * 
   * @param {Function} handler - Function to handle location changes
   */
  const registerLocationChangeHandler = useCallback((handler: ((location: TTSLocation) => void) | null) => {
    locationChangeHandlerRef.current = handler;
  }, []);

  const epubLocationWalkerRef = useRef<EpubRenderedLocationWalker | null>(null);

  const registerEpubLocationWalker = useCallback((walker: EpubRenderedLocationWalker | null) => {
    epubLocationWalkerRef.current = walker;
  }, []);

  /**
   * Resolves a CFI + segment text into stable EPUB coordinates. Registered by
   * the route-local EPUB reader hook (which owns the live `Book` instance). Used at server-persist
   * time so the saved locator carries `spineHref`/`spineIndex`/`charOffset`
   * rather than the viewport-dependent CFI string. Returns null when the CFI
   * can't be resolved — callers should drop the segment from the persist
   * payload in that case to avoid writing legacy-shape locators.
   */
  const epubLocatorResolverRef = useRef<EpubLocatorResolver | null>(null);

  const registerEpubLocatorResolver = useCallback((resolver: EpubLocatorResolver | null) => {
    epubLocatorResolverRef.current = resolver;
  }, []);

  /**
   * Walks the segment payload that's about to be POSTed to
   * /api/tts/segments/ensure and canonicalizes EPUB entries through the
   * registered resolver. This normalizes both draft and already-stable locators
   * to a spine-level canonical segment identity (text/key/index/locator).
   * Non-EPUB locators are untouched.
   *
   * Segments whose EPUB locators can't be resolved are DROPPED from the
   * payload — we'd rather persist nothing than persist a viewport-dependent
   * locator that will misbehave across devices and resizes.
   */
  const resolveSegmentsForPersist = useCallback(async (
    segments: TTSSegmentInput[],
  ): Promise<PersistResolution> => {
    const resolver = epubLocatorResolverRef.current;
    const out: TTSSegmentInput[] = [];
    const sourceIndices: number[] = [];
    for (let idx = 0; idx < segments.length; idx += 1) {
      const segment = segments[idx];
      const locator = segment.locator;
      if (!locator || locator.readerType !== 'epub') {
        out.push(segment);
        sourceIndices.push(idx);
        continue;
      }
      if (!resolver) {
        // No book available to resolve — drop. This can happen during early
        // boot before the EPUB reader hook has mounted.
        continue;
      }
      const keyPrefix = buildSegmentKeyPrefix(documentId, 'epub');
      try {
        const resolved = await resolver(locator, segment.text, {
          segmentIndex: segment.segmentIndex,
          segmentKey: segment.segmentKey ?? null,
          keyPrefix,
          maxBlockLength: ttsSegmentMaxBlockLength,
        });
        if (resolved && isStableEpubLocator(resolved.locator)) {
          out.push({
            ...segment,
            locator: resolved.locator,
            ...(typeof resolved.segmentKey === 'string' && resolved.segmentKey.trim()
              ? { segmentKey: resolved.segmentKey.trim() }
              : {}),
            ...(typeof resolved.segmentIndex === 'number' && Number.isFinite(resolved.segmentIndex)
              ? { segmentIndex: Math.max(0, Math.floor(resolved.segmentIndex)) }
              : {}),
            ...(typeof resolved.text === 'string' && resolved.text.trim()
              ? { text: resolved.text }
              : {}),
          });
          sourceIndices.push(idx);
        }
      } catch (error) {
        console.warn('Failed to resolve EPUB locator; dropping segment', error);
      }
    }
    return {
      segments: out,
      sourceIndices,
    };
  }, [documentId, ttsSegmentMaxBlockLength]);

  /**
   * Registers a handler function for visual page changes in EPUB documents
   * This is only used for EPUB documents to handle visual page navigation
   * 
   * @param {Function} handler - Function to handle visual page changes
   */
  const registerVisualPageChangeHandler = useCallback((handler: ((location: TTSLocation) => void) | null) => {
    visualPageChangeHandlerRef.current = handler;
  }, []);

  /**
   * State Management
   */
  const [isPlaying, setIsPlaying] = useState(false);
  const [isEPUB, setIsEPUB] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  /**
   * Resolved reader type for segment planning. Mirrors the `activeReaderType`
   * used inside `setText`/preload paths so external consumers (e.g. the
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
  const [currentIndex, setCurrentIndex] = useState(0);
  const [activeHowl, setActiveHowl] = useState<Howl | null>(null);
  const [speed, setSpeed] = useState(voiceSpeed);
  const [audioSpeed, setAudioSpeed] = useState(audioPlayerSpeed);
  const [voice, setVoice] = useState(configVoice);
  const [ttsModel, setTTSModel] = useState(configTTSModel);
  const [ttsInstructions, setTTSInstructions] = useState(configTTSInstructions);
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

  // Track pending preload requests
  const preloadRequests = useRef<Map<string, Promise<TTSSegmentPlaybackSource | null>>>(new Map());
  const segmentRetryCooldownRef = useRef<Map<string, number>>(new Map());
  const warmAudioCacheRef = useRef<Map<string, WarmAudioCacheEntry>>(new Map());
  // Track active abort controllers for TTS requests
  const activeAbortControllers = useRef<Set<AbortController>>(new Set());
  // Synchronous guard to prevent duplicate playAudio calls from the main playback effect.
  // React state updates (isProcessing, activeHowl) are async, so between the effect firing
  // and those guards taking effect, the effect can re-fire and start duplicate playback.
  // This is especially problematic in Firefox where HTML5 Audio events can cause extra renders.
  const playbackInFlightRef = useRef(false);
  const playbackRunIdRef = useRef(0);
  const pendingJumpTargetRef = useRef<TTSPendingJumpTarget | null>(null);
  // EPUB-only jump resolution. epub.js navigation snaps CFIs to page-aligned
  // values, so the strict locationKey match in pendingJumpTargetRef misses on
  // cross-spine jumps. We instead bump an epoch on each playFromSegment call
  // and let the next setText with a matching epoch consume the jump.
  const pendingEpubJumpRef = useRef<{ index: number; epoch: number } | null>(null);
  const epubJumpEpochRef = useRef<number>(0);
  const epubPreloadGenerationRef = useRef<number>(0);
  const epubWalkInFlightRef = useRef<Set<string>>(new Set());
  // Guard to coalesce rapid restarts and only resume the latest change
  const restartSeqRef = useRef(0);
  // Preserve autoplay intent across location changes. Some browsers can emit pause
  // events while we stop/unload between pages, which momentarily flips `isPlaying`
  // false and can prevent automatic resume on the next page.
  const resumeAfterLocationChangeRef = useRef(false);
  const pageTurnEstimateRef = useRef<TTSPageTurnEstimate | null>(null);
  const pageTurnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageFirstBlockFingerprintRef = useRef<Map<string, string>>(new Map());
  const sentenceAlignmentCacheRef = useRef<Map<string, TTSSentenceAlignment>>(new Map());
  const segmentManifestCacheRef = useRef<Map<string, TTSSegmentManifestItem>>(new Map());
  const [currentSentenceAlignment, setCurrentSentenceAlignment] = useState<TTSSentenceAlignment | undefined>();
  const [currentWordIndex, setCurrentWordIndex] = useState<number | null>(null);
  const isPlayingRef = useRef(false);
  const pauseEpochRef = useRef(0);
  const sentencesRef = useRef<string[]>([]);
  const currentIndexRef = useRef(0);
  const plannedSegmentsByLocationRef = useRef<Map<string, CanonicalTtsSegment[]>>(new Map());
  const currentSourceUnitRef = useRef<CanonicalTtsSourceUnit | null>(null);
  const currentSourceContextUnitsRef = useRef<CanonicalTtsSourceUnit[]>([]);
  const completedEpubBoundarySegmentRef = useRef<CompletedEpubBoundarySegment | null>(null);
  const pendingNextLocationRef = useRef<TTSLocation | undefined>(undefined);

  const audioUnlockAttemptRef = useRef(0);

  // Safari/iOS (HTML5 audio) can spontaneously reset playbackRate to 1. Keep re-applying
  // the desired rate while a sentence is playing.
  const rateWatchdogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearRateWatchdog = useCallback(() => {
    if (!rateWatchdogIntervalRef.current) return;
    clearInterval(rateWatchdogIntervalRef.current);
    rateWatchdogIntervalRef.current = null;
  }, []);

  const clearWarmAudioCache = useCallback(() => {
    warmAudioCacheRef.current.forEach((entry) => {
      releaseWarmAudio(entry.audio);
    });
    warmAudioCacheRef.current.clear();
  }, []);

  const warmSegmentAudioUrl = useCallback((requestKey: string, primaryUrl: string | null, fallbackUrl: string | null) => {
    const candidateUrl = primaryUrl || fallbackUrl;
    if (!candidateUrl) return;
    if (typeof window === 'undefined' || typeof Audio === 'undefined') return;

    upsertWarmAudioEntry({
      key: requestKey,
      url: candidateUrl,
      cache: warmAudioCacheRef.current,
      maxEntries: WARM_AUDIO_CACHE_MAX_ITEMS,
      createAudio: (url) => {
        const audio = new Audio(url);
        audio.preload = 'auto';
        audio.load();
        return audio;
      },
    });
  }, []);

  useEffect(() => () => {
    clearWarmAudioCache();
  }, [clearWarmAudioCache]);

  const applyPlaybackRateToHowl = useCallback((howl: Howl | null) => {
    if (!howl) return;

    try {
      howl.rate(audioSpeed);
    } catch {
      // ignore
    }

    // Best-effort: Howler doesn't expose the underlying HTMLAudioElement publicly.
    // This helps on browsers that reset playbackRate/defaultPlaybackRate.
    try {
      const sounds = (howl as unknown as { _sounds?: Array<{ _node?: unknown }> })._sounds;
      const node = sounds?.[0]?._node as unknown;
      if (node && typeof node === 'object') {
        const anyNode = node as { playbackRate?: number; defaultPlaybackRate?: number };
        if (typeof anyNode.playbackRate === 'number') anyNode.playbackRate = audioSpeed;
        if (typeof anyNode.defaultPlaybackRate === 'number') anyNode.defaultPlaybackRate = audioSpeed;
      }
    } catch {
      // ignore
    }
  }, [audioSpeed]);

  const startRateWatchdog = useCallback((howl: Howl | null) => {
    if (!howl) return;
    clearRateWatchdog();

    // Apply immediately + keep applying while playback is active.
    applyPlaybackRateToHowl(howl);
    rateWatchdogIntervalRef.current = setInterval(() => {
      applyPlaybackRateToHowl(howl);
    }, 250);
  }, [applyPlaybackRateToHowl, clearRateWatchdog]);

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
      const el = new Audio(SILENT_WAV_DATA_URI);
      try {
        el.setAttribute('playsinline', 'true');
      } catch {
        // ignore
      }
      el.preload = 'auto';
      el.volume = 0;

      const p = el.play();
      if (p && typeof (p as Promise<void>).then === 'function') {
        void (p as Promise<void>)
          .then(() => {
            if (audioUnlockAttemptRef.current !== attempt) return;
            try {
              el.pause();
              el.currentTime = 0;
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

  const setSegmentManifestCache = useCallback((key: string, item: TTSSegmentManifestItem) => {
    const cache = segmentManifestCacheRef.current;
    if (cache.has(key)) {
      cache.delete(key);
    }
    cache.set(key, item);
    while (cache.size > AUDIO_CACHE_MAX_ITEMS) {
      const oldestKey = cache.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      cache.delete(oldestKey);
    }
  }, []);

  const cacheCompletedManifestForCandidate = useCallback((
    cacheKey: string,
    segment: TTSSegmentManifestItem,
    alignmentEnabledForCurrentDoc: boolean,
  ): boolean => {
    if (segment.status !== 'completed' || !segment.audioPresignUrl || !segment.audioFallbackUrl) {
      return false;
    }
    setSegmentManifestCache(cacheKey, segment);
    if (alignmentEnabledForCurrentDoc && segment.alignment) {
      sentenceAlignmentCacheRef.current.set(cacheKey, segment.alignment);
    }
    return true;
  }, [setSegmentManifestCache]);

  const setSegmentRetryCooldown = useCallback((cacheKey: string, delayMs: number) => {
    const now = Date.now();
    const retryAtMs = now + Math.max(0, delayMs);
    const cooldowns = segmentRetryCooldownRef.current;
    cooldowns.set(cacheKey, retryAtMs);
    while (cooldowns.size > AUDIO_CACHE_MAX_ITEMS) {
      const oldestKey = cooldowns.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      cooldowns.delete(oldestKey);
    }
  }, []);

  const waitForRetryDelayWithAbort = useCallback((delayMs: number, signal: AbortSignal): Promise<void> => {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return Promise.resolve();
    if (signal.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }, []);

  const invalidatePlaybackRun = useCallback(() => {
    playbackRunIdRef.current += 1;
    playbackInFlightRef.current = false;
    epubPreloadGenerationRef.current += 1;
    epubWalkInFlightRef.current.clear();
  }, []);

  const bumpEpubPreloadGeneration = useCallback(() => {
    epubPreloadGenerationRef.current += 1;
    epubWalkInFlightRef.current.clear();
  }, []);

  const clearPendingEpubJump = useCallback(() => {
    pendingEpubJumpRef.current = null;
    epubJumpEpochRef.current += 1;
  }, []);

  const isAutoplayBlockedError = useCallback((err: unknown) => {
    const msg = (() => {
      if (typeof err === 'string') return err;
      if (err instanceof Error) return err.message;
      if (typeof err === 'object' && err !== null && 'message' in err) {
        const maybe = (err as { message?: unknown }).message;
        if (typeof maybe === 'string') return maybe;
      }
      return '';
    })();

    return /notallowed|not allowed|user gesture|interaction|autoplay|play\(\) failed/i.test(msg);
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
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  /**
   * Stops the current audio playback and clears the active Howl instance
   * @param {boolean} [clearPending=false] - Whether to clear pending requests
   */
  const abortAudio = useCallback((clearPending = false) => {
    // Ensure next playback attempt is not blocked by a stale in-flight guard.
    invalidatePlaybackRun();
    clearRateWatchdog();
    if (activeHowl) {
      activeHowl.stop();
      activeHowl.unload();
      setActiveHowl(null);
    }

    if (clearPending) {
      activeAbortControllers.current.forEach(controller => {
        controller.abort();
      });
      activeAbortControllers.current.clear();
      preloadRequests.current.clear();
      segmentRetryCooldownRef.current.clear();
      clearWarmAudioCache();
    }

    if (pageTurnTimeoutRef.current) {
      clearTimeout(pageTurnTimeoutRef.current);
      pageTurnTimeoutRef.current = null;
    }
    setCurrentWordIndex(null);
  }, [activeHowl, clearRateWatchdog, clearWarmAudioCache, invalidatePlaybackRun]);

  /**
   * Pauses the current audio playback while preserving seek position.
   */
  const pauseActiveHowl = useCallback(() => {
    clearRateWatchdog();
    if (activeHowl) {
      try {
        activeHowl.pause();
      } catch (error) {
        console.warn('Error pausing audio:', error);
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
  }, [activeHowl, clearRateWatchdog]);

  const abortPendingTtsRequests = useCallback((clearPreloadRequests = false) => {
    activeAbortControllers.current.forEach((controller) => {
      controller.abort();
    });
    activeAbortControllers.current.clear();
    if (clearPreloadRequests) {
      preloadRequests.current.clear();
    }
  }, []);

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
    abortPendingTtsRequests(true);
    pauseActiveHowl();
    setIsPlaying(false);
  }, [pauseActiveHowl, recordManualPause, clearPendingEpubJump, abortPendingTtsRequests]);

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

  /**
   * Moves to the next or previous sentence
   * 
   * @param {boolean} [backwards=false] - Whether to move backwards
   */
  const advance = useCallback(async (backwards = false) => {
    const nextIndex = currentIndex + (backwards ? -1 : 1);
    const movingForward = !backwards && nextIndex >= sentences.length;

    // Handle within current page bounds
    if (nextIndex < sentences.length && nextIndex >= 0) {
      if (
        !isEPUB &&
        !backwards &&
        currDocPages !== undefined &&
        currDocPageNumber < currDocPages &&
        nextIndex >= LOOP_GUARD_MIN_INDEX &&
        sentences.length > 0
      ) {
        const locationKey = normalizeLocationKey(currDocPageNumber);
        const cachedFirstFingerprint = pageFirstBlockFingerprintRef.current.get(locationKey)
          ?? normalizeBlockFingerprint(sentences[0] || '');
        const nextFingerprint = normalizeBlockFingerprint(sentences[nextIndex] || '');
        const progress = sentences.length > 1 ? nextIndex / (sentences.length - 1) : 0;

        if (
          cachedFirstFingerprint &&
          nextFingerprint &&
          cachedFirstFingerprint === nextFingerprint &&
          progress >= LOOP_GUARD_MIN_PROGRESS
        ) {
          const targetLocation = currDocPageNumber + 1;
          plannedSegmentsByLocationRef.current.delete(normalizeLocationKey(targetLocation));
          pendingNextLocationRef.current = targetLocation;
          skipToLocation(targetLocation);
          return;
        }
      }

      setCurrentIndex(nextIndex);
      return;
    }

    // For EPUB documents, always try to advance to next/prev section
    if (isEPUB && locationChangeHandlerRef.current) {
      if (movingForward && typeof document !== 'undefined' && document.hidden) {
        const targetLocation = pendingNextLocationRef.current;
        if (targetLocation !== undefined) {
          const bufferKey = normalizeLocationKey(targetLocation);
          const prefetchedSegments = plannedSegmentsByLocationRef.current.get(bufferKey);
          if (prefetchedSegments?.length) {
            plannedSegmentsByLocationRef.current.delete(bufferKey);
            pendingNextLocationRef.current = undefined;
            setCurrDocPage(targetLocation);
            setPlaybackSegments(prefetchedSegments);
            setSentences(prefetchedSegments.map((segment) => segment.text));
            setCurrentIndex(0);
            setCurrentSentenceAlignment(undefined);
            setCurrentWordIndex(null);
            // Ask the viewer to continue turning pages/sections; this may be deferred while hidden.
            locationChangeHandlerRef.current('next');
            return;
          }
        }
      }
      locationChangeHandlerRef.current(nextIndex >= sentences.length ? 'next' : 'prev');
      return;
    }

    // For PDFs and other documents, check page bounds
    if (!isEPUB) {
      // The HTML reader treats the entire document as a single page, so
      // `currDocPages` is left `undefined`. In that mode there's nowhere to
      // turn to — when we run past the last sentence, just stop playback.
      // (We do this before the page-bound checks below so the `< undefined`
      // / `>= undefined` NaN comparisons don't silently swallow the end.)
      if (currDocPages === undefined) {
        if (nextIndex >= sentences.length) {
          setIsPlaying(false);
        }
        return;
      }

      // Handle next/previous page transitions
      if ((nextIndex >= sentences.length && currDocPageNumber < currDocPages!) ||
        (nextIndex < 0 && currDocPageNumber > 1)) {
        const targetLocation = currDocPageNumber + (nextIndex >= sentences.length ? 1 : -1);

        // In background tabs, page text extraction can be delayed. If we already have
        // prefetched text for the target page, keep speaking without waiting for viewer callbacks.
        if (movingForward && typeof document !== 'undefined' && document.hidden) {
          const bufferKey = normalizeLocationKey(targetLocation);
          const prefetchedSegments = plannedSegmentsByLocationRef.current.get(bufferKey);
          if (prefetchedSegments?.length) {
            plannedSegmentsByLocationRef.current.delete(bufferKey);
            pendingNextLocationRef.current = undefined;
            setCurrDocPage(targetLocation);
            setPlaybackSegments(prefetchedSegments);
            setSentences(prefetchedSegments.map((segment) => segment.text));
            setCurrentIndex(0);
            setCurrentSentenceAlignment(undefined);
            setCurrentWordIndex(null);
            return;
          }
        }

        // Pass wasPlaying to maintain playback state during page turn
        skipToLocation(targetLocation);
        return;
      }

      // Handle end of document (PDF only)
      if (nextIndex >= sentences.length && currDocPageNumber >= currDocPages!) {
        setIsPlaying(false);
      }
    }
  }, [currentIndex, sentences, currDocPageNumber, currDocPages, isEPUB, skipToLocation]);

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

    const contextSourceUnits: CanonicalTtsSourceUnit[] = [];
    if (normalizedOptions.previousText?.trim()) {
      const previousLocation = normalizedOptions.previousLocation;
      contextSourceUnits.push({
        sourceKey: previousLocation !== undefined
          ? sourceKeyForLocation(previousLocation, currDocPage)
          : `previous:${currentSourceKey}`,
        text: normalizedOptions.previousText,
        locator: previousLocation !== undefined
          ? locatorForLocation(previousLocation, activeReaderType)
          : null,
      });
    }
    contextSourceUnits.push(...effectiveCurrentUnits);
    const sourceUnits: CanonicalTtsSourceUnit[] = [...contextSourceUnits];

    plannedSegmentsByLocationRef.current.clear();
    pendingNextLocationRef.current = normalizedOptions.nextLocation;
    const pendingPrefetches: Array<{
      location: TTSLocation;
      sourceUnits: CanonicalTtsSourceUnit[];
    }> = [];
    if (normalizedOptions.nextLocation !== undefined && normalizedOptions.nextText?.trim()) {
      const provided = normalizedOptions.nextSourceUnits?.filter((unit) => unit.text.trim().length > 0) ?? [];
      pendingPrefetches.push(provided.length > 0
        ? {
            location: normalizedOptions.nextLocation,
            sourceUnits: provided,
          }
        : {
            location: normalizedOptions.nextLocation,
            sourceUnits: [{
              sourceKey: sourceKeyForLocation(normalizedOptions.nextLocation, currDocPage),
              text: normalizedOptions.nextText,
              locator: locatorForLocation(normalizedOptions.nextLocation, activeReaderType),
            }],
          });
    }
    if (Array.isArray(normalizedOptions.upcomingLocations)) {
      for (const item of normalizedOptions.upcomingLocations) {
        if (item.location === undefined || !item.text?.trim()) continue;
        const provided = item.sourceUnits?.filter((unit) => unit.text.trim().length > 0) ?? [];
        pendingPrefetches.push(provided.length > 0
          ? {
              location: item.location,
              sourceUnits: provided,
            }
          : {
              location: item.location,
              sourceUnits: [{
                sourceKey: sourceKeyForLocation(item.location, currDocPage),
                text: item.text,
                locator: locatorForLocation(item.location, activeReaderType),
              }],
            });
      }
    }
    for (const item of pendingPrefetches) {
      sourceUnits.push(...item.sourceUnits);
    }

    const plan = planCanonicalTtsSegments(sourceUnits, {
      readerType: activeReaderType,
      maxBlockLength: ttsSegmentMaxBlockLength,
      keyPrefix: buildSegmentKeyPrefix(documentId, activeReaderType),
      enforceSourceBoundaries: activeReaderType === 'pdf' && currentUnits !== null && currentUnits.length > 0,
    });
    const currentSegments = plan.segments.filter((segment) => currentSourceKeySet.has(segment.ownerSourceKey));
    const newSentences = currentSegments.map((segment) => segment.text);

    for (const item of pendingPrefetches) {
      const sourceKeys = new Set(item.sourceUnits.map((unit) => unit.sourceKey));
      const planned = plan.segments.filter((segment) => sourceKeys.has(segment.ownerSourceKey));
      if (planned.length > 0) {
        plannedSegmentsByLocationRef.current.set(normalizeLocationKey(item.location), planned);
      }
    }

    currentSourceUnitRef.current = effectiveCurrentUnits[0] ?? null;
    currentSourceContextUnitsRef.current = contextSourceUnits;

    if (handleBlankSection(newSentences.join(' '))) return;

    const shouldPause = normalizedOptions.shouldPause ?? false;
    const pauseEpochAtStart = pauseEpochRef.current;
    const pendingAutoResume = resumeAfterLocationChangeRef.current;
    const shouldResumePlayback = !shouldPause && (isPlaying || pendingAutoResume);
    if (shouldPause || pendingAutoResume) {
      resumeAfterLocationChangeRef.current = false;
    }

    // Keep track of previous state and pause playback
    invalidatePlaybackRun();
    setIsPlaying(false);
    abortAudio(true); // Clear pending requests since text is changing
    setIsProcessing(true); // Set processing state before text processing starts

    try {
      if (newSentences.length === 0) {
        console.warn('No sentences found in text');
        setIsProcessing(false);
        return;
      }

      if (!isEPUB && typeof resolvedLocation === 'number') {
        const firstFingerprint = normalizeBlockFingerprint(newSentences[0] || '');
        if (firstFingerprint) {
          pageFirstBlockFingerprintRef.current.set(
            normalizeLocationKey(resolvedLocation),
            firstFingerprint
          );
        }
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
        startIndex = isEPUB && shouldResumePlayback
          ? resolveEpubBoundaryHandoffStartIndex(currentSegments, completedEpubBoundarySegmentRef.current)
          : 0;
        if (startIndex > 0) {
          completedEpubBoundarySegmentRef.current = null;
        }
        setCurrentIndex(startIndex);
      }

      sentenceAlignmentCacheRef.current.clear();
      setCurrentSentenceAlignment(undefined);
      setCurrentWordIndex(null);

      if (
        !isEPUB
        && normalizedOptions.nextLocation !== undefined
        && effectiveCurrentUnits.length === 1
      ) {
        const spanningIndex = currentSegments.findIndex((segment) =>
          segment.spansSourceBoundary
          && segment.startAnchor.sourceKey === currentSourceKey
          && segment.endAnchor.sourceKey !== currentSourceKey
        );
        const spanningSegment = spanningIndex >= 0 ? currentSegments[spanningIndex] : null;
        const currentTextLength = preprocessSentenceForAudio(text).length;
        const totalLength = spanningSegment ? preprocessSentenceForAudio(spanningSegment.text).length : 0;
        const baseLength = spanningSegment
          ? Math.max(0, currentTextLength - spanningSegment.startAnchor.offset)
          : 0;
        const fraction = totalLength > 0 ? baseLength / totalLength : 0;
        pageTurnEstimateRef.current = spanningSegment && fraction > 0 && fraction < 1
          ? {
            location: normalizedOptions.nextLocation,
            sentenceIndex: spanningIndex,
            fraction,
          }
          : null;
      } else {
        pageTurnEstimateRef.current = null;
      }

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
    clearPendingEpubJump,
  ]);

  /**
   * Toggles the playback state between playing and paused
   */
  const togglePlay = useCallback(() => {
    if (isPlaying) {
      recordManualPause();
      clearPendingEpubJump();
      abortPendingTtsRequests(true);
      pauseActiveHowl();
      setIsPlaying(false);
      return;
    }

    // Ensure audio is unlocked while we're still in the click/tap handler.
    unlockPlaybackOnUserGesture();

    // Resume current sentence if we already have a paused Howl.
    if (activeHowl) {
      applyPlaybackRateToHowl(activeHowl);
      playbackInFlightRef.current = true;
      try {
        activeHowl.play();
        setIsPlaying(true);
        return;
      } catch (error) {
        console.warn('Error resuming audio:', error);
        playbackInFlightRef.current = false;
        setActiveHowl(null);
      }
    }

    setIsPlaying(true);
  }, [
    activeHowl,
    applyPlaybackRateToHowl,
    isPlaying,
    pauseActiveHowl,
    recordManualPause,
    clearPendingEpubJump,
    abortPendingTtsRequests,
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
      fetchVoices();
      updateVoiceAndSpeed();
      setTTSModel(configTTSModel);
      setTTSInstructions(configTTSInstructions);
    }
  }, [configIsLoading, openApiKey, openApiBaseUrl, updateVoiceAndSpeed, fetchVoices, configTTSModel, configTTSInstructions]);

  const preloadGenerationSignatureRef = useRef<string>('');
  useEffect(() => {
    const signature = [
      documentId,
      configProviderRef,
      ttsModel,
      voice,
      effectiveNativeSpeed,
      providerModelPolicy.supportsInstructions ? ttsInstructions : '',
      ttsSegmentMaxBlockLength,
    ].join('|');

    if (!preloadGenerationSignatureRef.current) {
      preloadGenerationSignatureRef.current = signature;
      return;
    }
    if (preloadGenerationSignatureRef.current === signature) return;

    preloadGenerationSignatureRef.current = signature;
    clearPendingEpubJump();
    bumpEpubPreloadGeneration();
  }, [
    documentId,
    configProviderRef,
    ttsModel,
    voice,
    effectiveNativeSpeed,
    providerModelPolicy.supportsInstructions,
    ttsInstructions,
    ttsSegmentMaxBlockLength,
    clearPendingEpubJump,
    bumpEpubPreloadGeneration,
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

  const getSegmentPlaybackSource = useCallback(async (
    sentence: string,
    sentenceIndex: number,
    preload = false,
    locatorOverride?: TTSSegmentLocator,
    segmentKey?: string | null,
  ): Promise<TTSSegmentPlaybackSource | undefined> => {
    const alignmentEnabledForCurrentDoc =
      wordHighlightFeatureEnabled &&
      ((!isEPUB && pdfHighlightEnabled && pdfWordHighlightEnabled) ||
        (isEPUB && epubHighlightEnabled && epubWordHighlightEnabled));
    const locator = locatorOverride || locatorForLocation(
      isEPUB ? String(currDocPage) : Number(currDocPageNumber || 1),
      currentReaderType,
    );
    const audioCacheKey = buildScopedSegmentCacheKey(
      locator,
      sentenceIndex,
      sentence,
      voice,
      effectiveNativeSpeed,
      configProviderRef,
      ttsModel,
      configProviderType,
      providerModelPolicy.supportsInstructions ? ttsInstructions : '',
      segmentKey,
    );

    const cachedManifest = segmentManifestCacheRef.current.get(audioCacheKey);
    if (cachedManifest?.status === 'completed' && cachedManifest.audioPresignUrl && cachedManifest.audioFallbackUrl) {
      if (alignmentEnabledForCurrentDoc && cachedManifest.alignment) {
        sentenceAlignmentCacheRef.current.set(audioCacheKey, cachedManifest.alignment);
      }
      return {
        presignUrl: cachedManifest.audioPresignUrl,
        fallbackUrl: cachedManifest.audioFallbackUrl,
        manifest: cachedManifest,
      };
    }

    if (!documentId) {
      if (!preload) setIsPlaying(false);
      return undefined;
    }

    if (isAtLimit) {
      if (!preload) setIsPlaying(false);
      return undefined;
    }

    if (preload) {
      const retryAtMs = segmentRetryCooldownRef.current.get(audioCacheKey);
      if (shouldDeferSegmentRetry(Date.now(), retryAtMs)) {
        return undefined;
      }
    }

    const controller = new AbortController();
    activeAbortControllers.current.add(controller);

    const reqHeaders: TTSRequestHeaders = {
      'Content-Type': 'application/json',
      'x-openai-key': openApiKey || '',
      'x-tts-provider': configProviderRef,
    };
    if (openApiBaseUrl) {
      reqHeaders['x-openai-base-url'] = openApiBaseUrl;
    }

    const retryOptions: TTSRetryOptions = {
      maxRetries: 2,
      initialDelay: 300,
      maxDelay: 300,
    };

    try {
      onTTSStart();
      const maxStatusRetries = preload ? 1 : 3;
      let statusAttempt = 0;

      while (true) {
        const persistResult = await resolveSegmentsForPersist([
          {
            segmentIndex: sentenceIndex,
            ...(segmentKey ? { segmentKey } : {}),
            text: sentence,
            locator,
          },
        ]);
        const persistSegments = persistResult.segments;
        if (persistSegments.length === 0) {
          if (!preload) setIsPlaying(false);
          return undefined;
        }

        const ensured = await withRetry(
          async () => ensureTtsSegments({
            documentId,
            settings: {
              providerRef: configProviderRef,
              providerType: configProviderType,
              ttsModel,
              voice,
              nativeSpeed: effectiveNativeSpeed,
              ...(providerModelPolicy.supportsInstructions && ttsInstructions ? { ttsInstructions } : {}),
            },
            segments: persistSegments,
          }, reqHeaders, controller.signal),
          retryOptions,
        );

        const segment = ensured.segments[0];
        if (segment?.status === 'completed' && segment.audioPresignUrl && segment.audioFallbackUrl) {
          segmentRetryCooldownRef.current.delete(audioCacheKey);
          setSegmentManifestCache(audioCacheKey, segment);
          if (alignmentEnabledForCurrentDoc && segment.alignment) {
            sentenceAlignmentCacheRef.current.set(audioCacheKey, segment.alignment);
          }
          return {
            presignUrl: segment.audioPresignUrl,
            fallbackUrl: segment.audioFallbackUrl,
            manifest: segment,
          };
        }

        const status = segment?.status ?? 'missing';
        const retryAfterSeconds =
          typeof segment?.error?.retryAfterSeconds === 'number'
            ? segment.error.retryAfterSeconds
            : undefined;
        const delayMs = resolveSegmentStatusRetryDelayMs({
          attempt: statusAttempt,
          retryAfterSeconds,
        });
        const canRetryStatus = isRetryableSegmentStatus(status) && statusAttempt < maxStatusRetries;

        if (preload) {
          if (isRetryableSegmentStatus(status)) {
            setSegmentRetryCooldown(audioCacheKey, delayMs);
          }
          if (canRetryStatus) {
            statusAttempt += 1;
            await waitForRetryDelayWithAbort(delayMs, controller.signal);
            continue;
          }
          return undefined;
        }

        if (canRetryStatus) {
          statusAttempt += 1;
          await waitForRetryDelayWithAbort(delayMs, controller.signal);
          continue;
        }

        const detail = (() => {
          if (typeof segment?.error?.detail === 'string' && segment.error.detail.trim()) {
            return ` (${segment.error.detail})`;
          }
          return '';
        })();
        throw new Error(`Failed to prepare segment audio: ${status}${detail}`);
      }
    } catch (error) {
      if (isAbortLikeError(error)) {
        return undefined;
      }
      const status = (() => {
        if (typeof error === 'object' && error !== null && 'status' in error) {
          const maybe = (error as { status?: unknown }).status;
          return typeof maybe === 'number' ? maybe : undefined;
        }
        return undefined;
      })();
      const code = (() => {
        if (typeof error === 'object' && error !== null && 'code' in error) {
          const maybe = (error as { code?: unknown }).code;
          return typeof maybe === 'string' ? maybe : undefined;
        }
        return undefined;
      })();
      if (status === 429 && code === 'USER_DAILY_QUOTA_EXCEEDED') {
        if (!preload) {
          toast.error('Daily TTS limit reached.', {
            id: 'tts-limit-error',
            duration: 5000,
          });
        }
        triggerRateLimit();
        refreshRateLimit().catch(console.error);
        return undefined;
      }
      if (!preload) {
        setIsPlaying(false);
        toast.error('TTS failed. Skipped sentence and paused.', {
          id: 'tts-api-error',
          duration: 7000,
        });
      }
      throw error;
    } finally {
      activeAbortControllers.current.delete(controller);
      onTTSComplete();
    }
  }, [
    voice,
    effectiveNativeSpeed,
    ttsModel,
    ttsInstructions,
    openApiKey,
    openApiBaseUrl,
    configProviderRef,
    configProviderType,
    providerModelPolicy.supportsInstructions,
    isEPUB,
    pdfHighlightEnabled,
    pdfWordHighlightEnabled,
    epubHighlightEnabled,
    epubWordHighlightEnabled,
    onTTSComplete,
    onTTSStart,
    isAtLimit,
    documentId,
    refreshRateLimit,
    triggerRateLimit,
    currDocPage,
    currDocPageNumber,
    currentReaderType,
    setSegmentManifestCache,
    setSegmentRetryCooldown,
    waitForRetryDelayWithAbort,
    isAbortLikeError,
    resolveSegmentsForPersist,
  ]);

  /**
   * Processes and plays the current sentence
   *
   * @param {string} sentence - The sentence to process
   * @param {boolean} [preload=false] - Whether this is a preload request
   * @returns {Promise<TTSSegmentPlaybackSource | null>} Prepared playback source metadata
   */
  const processSentence = useCallback(async (
    sentence: string,
    sentenceIndex: number,
    preload = false,
    locatorOverride?: TTSSegmentLocator,
    segmentKey?: string | null,
  ): Promise<TTSSegmentPlaybackSource | null> => {
    if (!audioContext) throw new Error('Audio context not initialized');
    const locator = locatorOverride || locatorForLocation(
      isEPUB ? String(currDocPage) : Number(currDocPageNumber || 1),
      currentReaderType,
    );
    const requestKey = buildSegmentRequestKey(locator, sentenceIndex, sentence, segmentKey);

    // Check if there's a pending preload request for this sentence
    const pendingRequest = preloadRequests.current.get(requestKey);
    if (pendingRequest) {
      if (preload) {
        return pendingRequest;
      }
      // Foreground playback must not block on batch preload promises, which can
      // include many other candidates and stall autoplay progression.
      preloadRequests.current.delete(requestKey);
    }

    // Only set processing state if not preloading
    if (!preload) setIsProcessing(true);

    // Create the audio processing promise
    const processPromise = (async () => {
      try {
        const source = await getSegmentPlaybackSource(sentence, sentenceIndex, preload, locatorOverride, segmentKey);
        if (preload && source) {
          warmSegmentAudioUrl(requestKey, source.presignUrl, source.fallbackUrl);
        }
        return source || null;
      } catch (error) {
        setIsProcessing(false);
        throw error;
      }
    })();

    // If this is a preload request, store it in the map
    if (preload) {
      preloadRequests.current.set(requestKey, processPromise);
      // Clean up the map entry once the promise resolves or rejects
      void processPromise
        .finally(() => {
          preloadRequests.current.delete(requestKey);
        })
        .catch(() => {
          // Prevent unhandled rejections from the cleanup-only chained promise.
        });
    }

    return processPromise;
  }, [audioContext, getSegmentPlaybackSource, currDocPage, currDocPageNumber, currentReaderType, isEPUB, warmSegmentAudioUrl]);

  /**
   * Plays the current sentence with Howl
   * 
   * @param {string} sentence - The sentence to play
   */
  const playSentenceWithHowl = useCallback(async (
    sentence: string,
    sentenceIndex: number,
    runId: number,
    segmentKey?: string | null,
    playbackSegment?: CanonicalTtsSegment | null,
  ) => {
    if (!sentence) {
      playbackInFlightRef.current = false;
      setIsProcessing(false);
      return;
    }

    const MAX_RETRIES = 3;
    const INITIAL_RETRY_DELAY = 1000; // 1 second

    const createHowl = async (
      retryCount = 0,
      useFallbackSource = false,
    ): Promise<Howl | null> => {
      if (runId !== playbackRunIdRef.current) return null;
      let playErrorAttempts = 0;
      const playbackSource = await processSentence(sentence, sentenceIndex, false, undefined, segmentKey);
      if (runId !== playbackRunIdRef.current) return null;
      if (!playbackSource) {
        // Graceful exit for rate limit / abort / intentionally skipped sentence
        return null;
      }
      // Ensure word highlighting is set even when alignment arrives from a fresh ensure
      // during this playback attempt (before cache-based pre-read can see it).
      if (playbackSource.manifest.alignment) {
        setCurrentSentenceAlignment(playbackSource.manifest.alignment);
        setCurrentWordIndex(null);
      }
      const audioUrl = useFallbackSource ? playbackSource.fallbackUrl : playbackSource.presignUrl;

      // Force unload any previous Howl instance to free up resources
      if (activeHowl) {
        activeHowl.unload();
      }

      // Guard against Firefox firing onend/onstop multiple times for the same Audio element.
      let howlFinished = false;

      return new Howl({
        src: [audioUrl],
        format: ['mp3', 'mpeg'],
        html5: true,
        preload: true,
        // We never need overlapping playback for a single sentence. Keeping this low avoids
        // Safari/HTML5 Audio pool exhaustion when retries happen.
        pool: 1,
        rate: audioSpeed,
        onload: function (this: Howl) {
          if (runId !== playbackRunIdRef.current) {
            try { this.unload(); } catch {}
            return;
          }
          applyPlaybackRateToHowl(this);
          const estimate = pageTurnEstimateRef.current;
          if (!estimate || estimate.sentenceIndex !== sentenceIndex) return;
          if (!visualPageChangeHandlerRef.current) return;

          const duration = this.duration();
          if (!duration || !Number.isFinite(duration)) return;

          const delayMs = duration * estimate.fraction * 1000;
          if (delayMs <= 0 || delayMs >= duration * 1000) return;

          if (pageTurnTimeoutRef.current) {
            clearTimeout(pageTurnTimeoutRef.current);
          }

          pageTurnTimeoutRef.current = setTimeout(() => {
            if (!isPlaying) return;
            const currentEstimate = pageTurnEstimateRef.current;
            if (!currentEstimate || currentEstimate.sentenceIndex !== sentenceIndex) return;
            visualPageChangeHandlerRef.current?.(currentEstimate.location);
          }, delayMs);
        },
        onplay: function (this: Howl) {
          if (runId !== playbackRunIdRef.current) {
            try { this.unload(); } catch {}
            return;
          }
          setIsProcessing(false);
          startRateWatchdog(this);
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
          }
        },
        onpause: function () {
          if (runId !== playbackRunIdRef.current) return;
          clearRateWatchdog();
          playbackInFlightRef.current = false;
          setIsProcessing(false);
          if (pageTurnTimeoutRef.current) {
            clearTimeout(pageTurnTimeoutRef.current);
            pageTurnTimeoutRef.current = null;
          }
          setIsPlaying(false);
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'paused';
          }
        },
        onplayerror: function (this: Howl, soundId, error) {
          if (runId !== playbackRunIdRef.current) {
            try { this.unload(); } catch {}
            return;
          }
          const actualError = error ?? soundId;
          console.warn('Howl playback error:', actualError);

          // Common on iOS/Safari when the actual play() call happens after awaiting TTS.
          // Do not skip/advance in this case; just pause and tell the user to tap play again.
          if (isAutoplayBlockedError(actualError)) {
            howlFinished = true;
            playbackInFlightRef.current = false;
            setIsProcessing(false);
            setActiveHowl(null);
            try {
              this.unload();
            } catch {
              // ignore unload errors
            }
            setIsPlaying(false);

            toast.error('Playback was blocked by your browser. Tap play again to start.', {
              id: 'tts-playback-blocked',
              duration: 4000,
            });
            return;
          }

          playErrorAttempts += 1;

          // Avoid looping for many seconds on Safari: if playback still fails after a single
          // recovery attempt, skip the sentence and pause.
          if (playErrorAttempts > 1) {
            howlFinished = true;
            playbackInFlightRef.current = false;
            setIsProcessing(false);
            setActiveHowl(null);
            this.unload();
            setIsPlaying(false);

            toast.error('Audio playback failed. Skipped sentence and paused.', {
              id: 'tts-playback-error',
              duration: 4000,
            });

            advance();
            return;
          }

          // Try to recover by reloading once.
          if (this.state() === 'loaded') {
            this.unload();
            this.once('load', () => this.play());
            this.load();
          }
        },
        onloaderror: async function (this: Howl, soundId, error) {
          if (runId !== playbackRunIdRef.current) {
            try { this.unload(); } catch {}
            return;
          }
          const actualError = error ?? soundId;
          console.warn(`Error loading audio (attempt ${retryCount + 1}/${MAX_RETRIES}):`, actualError);

          // First load failure on presigned URL should fail over to proxy fallback immediately.
          if (!useFallbackSource && playbackSource.fallbackUrl && playbackSource.fallbackUrl !== playbackSource.presignUrl) {
            try {
              this.unload();
            } catch {
              // ignore unload errors
            }

            try {
              const fallbackHowl = await createHowl(retryCount, true);
              if (fallbackHowl) {
                if (runId !== playbackRunIdRef.current) {
                  try { fallbackHowl.unload(); } catch {}
                  return;
                }
                setActiveHowl(fallbackHowl);
                fallbackHowl.play();
                return;
              }
            } catch (fallbackError) {
              console.error('Error switching to fallback segment source:', fallbackError);
            }
          }

          if (retryCount < MAX_RETRIES) {
            // Calculate exponential backoff delay
            const delay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);

            // Free the current Howl/audio objects before retrying to avoid pool exhaustion.
            try {
              this.unload();
            } catch {
              // ignore unload errors
            }

            // Wait for the delay
            await new Promise(resolve => setTimeout(resolve, delay));

            // Try to create a new Howl instance
            try {
              const retryHowl = await createHowl(retryCount + 1, useFallbackSource);
              if (retryHowl) {
                if (runId !== playbackRunIdRef.current) {
                  try { retryHowl.unload(); } catch {}
                  return;
                }
                setActiveHowl(retryHowl);
                retryHowl.play();
              } else {
                // No audio generated (quota/abort). Stop cleanly without spamming errors.
                howlFinished = true;
                playbackInFlightRef.current = false;
                setIsProcessing(false);
                setActiveHowl(null);
                setIsPlaying(false);
              }
            } catch (err) {
              console.error('Error creating Howl instance:', err);
              howlFinished = true;
              playbackInFlightRef.current = false;
              setIsProcessing(false);
              setActiveHowl(null);
              setIsPlaying(false);

              toast.error('Audio loading failed after retries. Moving to next sentence...', {
                id: 'audio-load-error',
                duration: 2000,
              });

              advance();
            }
          } else {
            console.error('Max retries reached, moving to next sentence');
            howlFinished = true;
            playbackInFlightRef.current = false;
            setIsProcessing(false);
            setActiveHowl(null);
            this.unload();
            setIsPlaying(false);

            toast.error('Audio loading failed after retries. Moving to next sentence...', {
              id: 'audio-load-error',
              duration: 2000,
            });

            advance();
          }
        },
        onend: function (this: Howl) {
          if (runId !== playbackRunIdRef.current) {
            try { this.unload(); } catch {}
            return;
          }
          if (howlFinished) return; // Deduplicate – Firefox can fire ended twice
          howlFinished = true;
          clearRateWatchdog();
          this.unload();
          playbackInFlightRef.current = false;
          setActiveHowl(null);
          if (pageTurnTimeoutRef.current) {
            clearTimeout(pageTurnTimeoutRef.current);
            pageTurnTimeoutRef.current = null;
          }
          if (isEPUB) {
            completedEpubBoundarySegmentRef.current = completedEpubBoundarySegment(playbackSegment);
          }
          if (isPlaying) {
            advance();
          }
        },
        onstop: function (this: Howl) {
          if (runId !== playbackRunIdRef.current) {
            try { this.unload(); } catch {}
            return;
          }
          if (howlFinished) return;
          howlFinished = true;
          clearRateWatchdog();
          playbackInFlightRef.current = false;
          setIsProcessing(false);
          this.unload();
        }
      });
    };

    try {
      const howl = await createHowl();
      if (runId !== playbackRunIdRef.current) {
        if (howl) {
          try { howl.unload(); } catch {}
        }
        return null;
      }
      if (!howl) {
        // No audio generated (quota hit / aborted / intentionally skipped). Stop cleanly without
        // advancing or spamming errors.
        playbackInFlightRef.current = false;
        setActiveHowl(null);
        setIsProcessing(false);
        setIsPlaying(false);
        return null;
      }

      setActiveHowl(howl);
      return howl;
    } catch (error) {
      console.error('Error playing TTS:', error);
      playbackInFlightRef.current = false;
      setActiveHowl(null);
      setIsProcessing(false);

      // Skip the sentence but pause playback (user can resume manually).
      abortAudio(true);
      setIsPlaying(false);
      advance();
      return null;
    }
  }, [
    abortAudio,
    isPlaying,
    advance,
    activeHowl,
    processSentence,
    audioSpeed,
    isEPUB,
    isAutoplayBlockedError,
    applyPlaybackRateToHowl,
    startRateWatchdog,
    clearRateWatchdog,
  ]);

  const playAudio = useCallback(async () => {
    const runId = playbackRunIdRef.current;
    const playbackSegment = playbackSegments[currentIndex];
    const sentence = playbackSegment?.text ?? sentences[currentIndex];
    if (isEPUB && playbackSegment && completedEpubBoundarySegmentRef.current) {
      const suppression = resolveEpubReplaySuppressionAction(
        playbackSegments,
        currentIndex,
        completedEpubBoundarySegmentRef.current,
      );
      if (suppression.kind === 'skip-to-index') {
        playbackInFlightRef.current = false;
        setCurrentSentenceAlignment(undefined);
        setCurrentWordIndex(null);
        completedEpubBoundarySegmentRef.current = null;
        setCurrentIndex(suppression.index);
        return;
      }
      if (suppression.kind === 'pause') {
        playbackInFlightRef.current = false;
        setCurrentSentenceAlignment(undefined);
        setCurrentWordIndex(null);
        completedEpubBoundarySegmentRef.current = null;
        setIsProcessing(false);
        setIsPlaying(false);
        return;
      }
      completedEpubBoundarySegmentRef.current = null;
    }
    const activeLocator: TTSSegmentLocator = playbackSegment?.ownerLocator
      ?? locatorForLocation(
        isEPUB ? String(currDocPage) : Number(currDocPageNumber || 1),
        currentReaderType,
      );
    const alignmentKey = buildScopedSegmentCacheKey(
      activeLocator,
      currentIndex,
      sentence,
      voice,
      effectiveNativeSpeed,
      configProviderRef,
      ttsModel,
      configProviderType,
      providerModelPolicy.supportsInstructions ? ttsInstructions : '',
      playbackSegment?.key,
    );
    const cachedAlignment = sentenceAlignmentCacheRef.current.get(alignmentKey);
    if (cachedAlignment) {
      setCurrentSentenceAlignment(cachedAlignment);
      setCurrentWordIndex(null);
    } else {
      setCurrentSentenceAlignment(undefined);
      setCurrentWordIndex(null);
    }

    const howl = await playSentenceWithHowl(sentence, currentIndex, runId, playbackSegment?.key, playbackSegment);
    if (runId !== playbackRunIdRef.current) {
      if (howl) {
        try { howl.unload(); } catch {}
      }
      return;
    }
    if (howl) {
      if (!isPlayingRef.current) {
        playbackInFlightRef.current = false;
        return;
      }
      howl.play();
    }
  }, [
    sentences,
    playbackSegments,
    currentIndex,
    playSentenceWithHowl,
    voice,
    effectiveNativeSpeed,
    configProviderRef,
    ttsModel,
    configProviderType,
    providerModelPolicy.supportsInstructions,
    ttsInstructions,
    isEPUB,
    currDocPage,
    currDocPageNumber,
    currentReaderType,
  ]);

  // Keep the current playback rate applied to the active Howl. Some browsers (notably
  // iOS Safari with HTML5 audio) can reset playbackRate after initial load/play.
  useEffect(() => {
    if (!activeHowl) return;
    applyPlaybackRateToHowl(activeHowl);
    if (isPlaying) {
      startRateWatchdog(activeHowl);
    }
  }, [activeHowl, audioSpeed, applyPlaybackRateToHowl, isPlaying, startRateWatchdog]);

  // Track the current word index during playback using Howler's seek position
  useEffect(() => {
    if (!activeHowl || !isPlaying || !currentSentenceAlignment || !currentSentenceAlignment.words.length) {
      setCurrentWordIndex(null);
      return;
    }

    let frameId: number;

    const tick = () => {
      try {
        const pos = activeHowl.seek() as number;
        if (typeof pos === 'number' && Number.isFinite(pos)) {
          const words = currentSentenceAlignment.words;
          let idx = -1;
          for (let i = 0; i < words.length; i++) {
            const w = words[i];
            if (pos >= w.startSec && pos < w.endSec) {
              idx = i;
              break;
            }
          }
          if (idx !== -1) {
            setCurrentWordIndex((prev) => (prev === idx ? prev : idx));
          }
        }
      } catch {
        // ignore seek errors
      }
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);

    return () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [activeHowl, isPlaying, currentSentenceAlignment]);

  /**
   * Preloads upcoming sentences in batched ensure requests.
   * Includes the current location and prefetched future locations when available.
   */
  const preloadNextAudio = useCallback(() => {
    if (isAtLimit || !documentId) return;
    const sentenceLookahead = clampSegmentPreloadSentenceLookahead(segmentPreloadSentenceLookahead);

    const maxDepth = clampSegmentPreloadDepth(segmentPreloadDepthPages);

    if (isEPUB) {
      const generationAtStart = epubPreloadGenerationRef.current;
      const settingsHash = [
        configProviderRef,
        ttsModel,
        voice,
        effectiveNativeSpeed,
        providerModelPolicy.supportsInstructions ? ttsInstructions : '',
      ].join('|');
      const walkStartKey = `${currDocPage}|${settingsHash}|${ttsSegmentMaxBlockLength}|${maxDepth}`;

      const preloadFromOffset = (offset: number) => {
        if (offset > sentenceLookahead) return;
        const sentenceIndex = currentIndex + offset;
        const nextSegment = playbackSegments[sentenceIndex];
        const nextSentence = nextSegment?.text ?? sentences[sentenceIndex];
        if (!nextSentence) return;

        const currentLocator: TTSSegmentLocator =
          nextSegment?.ownerLocator ?? { location: String(currDocPage), readerType: currentReaderType };
        const requestKey = buildSegmentRequestKey(currentLocator, sentenceIndex, nextSentence, nextSegment?.key);
        const cacheKey = buildScopedSegmentCacheKey(
          currentLocator,
          sentenceIndex,
          nextSentence,
          voice,
          effectiveNativeSpeed,
          configProviderRef,
          ttsModel,
          configProviderType,
          providerModelPolicy.supportsInstructions ? ttsInstructions : '',
          nextSegment?.key,
        );
        if (segmentManifestCacheRef.current.has(cacheKey)) {
          preloadFromOffset(offset + 1);
          return;
        }
        const cooldownRetryAtMs = segmentRetryCooldownRef.current.get(cacheKey);
        if (shouldDeferSegmentRetry(Date.now(), cooldownRetryAtMs)) {
          preloadFromOffset(offset + 1);
          return;
        }
        const pending = preloadRequests.current.get(requestKey);
        if (pending) {
          void pending
            .finally(() => preloadFromOffset(offset + 1))
            .catch(() => {});
          return;
        }

        void processSentence(nextSentence, sentenceIndex, true, currentLocator, nextSegment?.key)
          .catch((error) => {
            const status = typeof error === 'object' && error !== null && 'status' in error
              ? ((error as { status?: unknown }).status as number | undefined)
              : undefined;
            const code = typeof error === 'object' && error !== null && 'code' in error
              ? ((error as { code?: unknown }).code as string | undefined)
              : undefined;
            if (!isAbortLikeError(error) && !(status === 429 && code === 'USER_DAILY_QUOTA_EXCEEDED')) {
              console.error(`Error preloading EPUB sentence at offset ${offset}:`, error);
            }
          })
          .finally(() => preloadFromOffset(offset + 1));
      };

      preloadFromOffset(1);
      if (
        maxDepth <= 1
        || !epubLocationWalkerRef.current
        || typeof currDocPage !== 'string'
        || epubWalkInFlightRef.current.has(walkStartKey)
      ) {
        return;
      }
      epubWalkInFlightRef.current.add(walkStartKey);

      const controller = new AbortController();
      activeAbortControllers.current.add(controller);
      const reqHeaders: TTSRequestHeaders = {
        'Content-Type': 'application/json',
        'x-openai-key': openApiKey || '',
        'x-tts-provider': configProviderRef,
      };
      if (openApiBaseUrl) {
        reqHeaders['x-openai-base-url'] = openApiBaseUrl;
      }
      const retryOptions: TTSRetryOptions = {
        maxRetries: 2,
        initialDelay: 300,
        maxDelay: 300,
      };
      let started = false;
      const alignmentEnabledForCurrentDoc =
        wordHighlightFeatureEnabled &&
        epubHighlightEnabled &&
        epubWordHighlightEnabled;

      const requestedDepth = Math.max(1, maxDepth);
      void epubLocationWalkerRef.current(currDocPage, requestedDepth, controller.signal)
        .then(async (locationItems) => {
          if (controller.signal.aborted) return;
          if (generationAtStart !== epubPreloadGenerationRef.current) return;
          if (!locationItems.length) return;

          const upcomingLocationItems = selectUpcomingWalkerItems(
            locationItems,
            String(currDocPage),
            maxDepth,
          );
          if (!upcomingLocationItems.length) return;

          // Build a stable EPUB locator for each rendered chunk from the
          // walker's spine coordinates. These are viewport-independent — the
          // same content yields the same locator across devices and resizes.
          const locatorForWalkerItem = (
            item: typeof upcomingLocationItems[number],
          ): TTSSegmentLocator => ({
            readerType: 'epub',
            spineHref: item.spineHref,
            spineIndex: item.spineIndex,
            charOffset: item.chunkOffset,
            cfi: item.cfi,
          });

          const upcomingUnits: CanonicalTtsSourceUnit[] = upcomingLocationItems.map((item) => ({
            sourceKey: sourceKeyForLocation(item.cfi, currDocPage),
            text: item.text,
            locator: locatorForWalkerItem(item),
          }));
          const liveContextUnits = currentSourceContextUnitsRef.current.length > 0
            ? currentSourceContextUnitsRef.current
            : (currentSourceUnitRef.current ? [currentSourceUnitRef.current] : []);
          const sourceUnits: CanonicalTtsSourceUnit[] = buildWalkerPlanningSourceUnits(
            liveContextUnits,
            upcomingUnits,
          );

          const plan = planCanonicalTtsSegments(sourceUnits, {
            readerType: 'epub',
            maxBlockLength: ttsSegmentMaxBlockLength,
            keyPrefix: buildSegmentKeyPrefix(documentId, 'epub'),
          });
          const uniqueCandidates: Array<EpubLocationPreloadCandidate & { locator: TTSSegmentLocator }> = [];
          const seenCandidates = new Set<string>();
          for (const item of upcomingLocationItems) {
            const sourceKey = sourceKeyForLocation(item.cfi, currDocPage);
            const planned = plan.segments
              .filter((segment) => segment.ownerSourceKey === sourceKey)
              .slice(0, sentenceLookahead);
            for (let index = 0; index < planned.length; index += 1) {
              const segment = planned[index];
              const locator = segment.ownerLocator ?? locatorForWalkerItem(item);
              const requestKey = buildSegmentRequestKey(locator, index, segment.text, segment.key);
              const cacheKey = buildScopedSegmentCacheKey(
                locator,
                index,
                segment.text,
                voice,
                effectiveNativeSpeed,
                configProviderRef,
                ttsModel,
                configProviderType,
                providerModelPolicy.supportsInstructions ? ttsInstructions : '',
                segment.key,
              );
              if (seenCandidates.has(requestKey)) continue;
              seenCandidates.add(requestKey);
              if (segmentManifestCacheRef.current.has(cacheKey)) continue;
              const cooldownRetryAtMs = segmentRetryCooldownRef.current.get(cacheKey);
              if (shouldDeferSegmentRetry(Date.now(), cooldownRetryAtMs)) continue;
              if (preloadRequests.current.has(requestKey)) continue;
              uniqueCandidates.push({
                sentence: segment.text,
                segmentKey: segment.key,
                segmentIndex: index,
                location: item.cfi,
                requestKey,
                cacheKey,
                locator,
              });
            }
          }
          if (uniqueCandidates.length === 0) return;

          const payload = uniqueCandidates.map((candidate) => ({
            segmentIndex: candidate.segmentIndex,
            segmentKey: candidate.segmentKey,
            text: candidate.sentence,
            locator: candidate.locator,
          }));

          const preloadPromise = (async (): Promise<void> => {
            onTTSStart();
            started = true;
            const persistResult = await resolveSegmentsForPersist(payload);
            const persistPayload = persistResult.segments;
            if (persistPayload.length === 0) return;
            const ensured = await withRetry(
              async () => ensureTtsSegments({
                documentId,
                settings: {
                  providerRef: configProviderRef,
                  providerType: configProviderType,
                  ttsModel,
                  voice,
                  nativeSpeed: effectiveNativeSpeed,
                  ...(providerModelPolicy.supportsInstructions && ttsInstructions ? { ttsInstructions } : {}),
                },
                segments: persistPayload,
              }, reqHeaders, controller.signal),
              retryOptions,
            );

            if (generationAtStart !== epubPreloadGenerationRef.current) return;

            ensured.segments.forEach((segment, persistIndex) => {
              if (segment.status !== 'completed' || !segment.audioPresignUrl || !segment.audioFallbackUrl) return;
              const sourceIndex = persistResult.sourceIndices[persistIndex];
              if (sourceIndex === undefined) return;
              const candidate = uniqueCandidates[sourceIndex];
              if (!candidate) return;
              cacheCompletedManifestForCandidate(candidate.cacheKey, segment, alignmentEnabledForCurrentDoc);
            });
          })();

          for (const candidate of uniqueCandidates) {
            const candidatePromise: Promise<TTSSegmentPlaybackSource | null> = preloadPromise.then(() => {
              const manifest = segmentManifestCacheRef.current.get(candidate.cacheKey);
              if (!manifest || manifest.status !== 'completed' || !manifest.audioPresignUrl || !manifest.audioFallbackUrl) {
                return null;
              }
              warmSegmentAudioUrl(candidate.requestKey, manifest.audioPresignUrl, manifest.audioFallbackUrl);
              return {
                presignUrl: manifest.audioPresignUrl,
                fallbackUrl: manifest.audioFallbackUrl,
                manifest,
              };
            });
            void candidatePromise.catch(() => {});
            preloadRequests.current.set(candidate.requestKey, candidatePromise);
          }

          await preloadPromise.finally(() => {
            for (const candidate of uniqueCandidates) {
              preloadRequests.current.delete(candidate.requestKey);
            }
          });
        })
        .catch((error) => {
          const status = typeof error === 'object' && error !== null && 'status' in error
            ? ((error as { status?: unknown }).status as number | undefined)
            : undefined;
          const code = typeof error === 'object' && error !== null && 'code' in error
            ? ((error as { code?: unknown }).code as string | undefined)
            : undefined;
          if (!isAbortLikeError(error) && !(status === 429 && code === 'USER_DAILY_QUOTA_EXCEEDED')) {
            console.error('Error preloading EPUB location segments:', error);
          }
        })
        .finally(() => {
          epubWalkInFlightRef.current.delete(walkStartKey);
          activeAbortControllers.current.delete(controller);
          if (started) {
            onTTSComplete();
          }
        });
      return;
    }

    const alignmentEnabledForCurrentDoc =
      wordHighlightFeatureEnabled &&
      ((!isEPUB && pdfHighlightEnabled && pdfWordHighlightEnabled) ||
        (isEPUB && epubHighlightEnabled && epubWordHighlightEnabled));
    const candidates: Array<{
      sentence: string;
      segmentKey?: string | null;
      segmentIndex: number;
      locator: TTSSegmentLocator;
      requestKey: string;
      cacheKey: string;
    }> = [];

    const currentLocator: TTSSegmentLocator = locatorForLocation(
      isEPUB ? String(currDocPage) : Number(currDocPageNumber || 1),
      currentReaderType,
    );

    for (let offset = 1; offset <= sentenceLookahead; offset += 1) {
      const sentenceIndex = currentIndex + offset;
      const plannedSegment = playbackSegments[sentenceIndex];
      const sentence = plannedSegment?.text ?? sentences[sentenceIndex];
      if (!sentence) break;
      const locator = plannedSegment?.ownerLocator ?? currentLocator;
      const cacheKey = buildScopedSegmentCacheKey(
        locator,
        sentenceIndex,
        sentence,
        voice,
        effectiveNativeSpeed,
        configProviderRef,
        ttsModel,
        configProviderType,
        providerModelPolicy.supportsInstructions ? ttsInstructions : '',
        plannedSegment?.key,
      );
      const requestKey = buildSegmentRequestKey(locator, sentenceIndex, sentence, plannedSegment?.key);
      candidates.push({ sentence, segmentKey: plannedSegment?.key, segmentIndex: sentenceIndex, locator, requestKey, cacheKey });
    }

    const prefetched = Array.from(plannedSegmentsByLocationRef.current.entries()).slice(0, maxDepth);
    for (const [locationKey, planned] of prefetched) {
      if (!planned.length) continue;
      const location = locationKey.startsWith('num:')
        ? Number(locationKey.slice(4))
        : locationKey.startsWith('str:')
          ? locationKey.slice(4)
          : null;
      if (location === null) continue;

      const locator: TTSSegmentLocator = locatorForLocation(location, currentReaderType);
      for (let index = 0; index < Math.min(sentenceLookahead, planned.length); index += 1) {
        const segment = planned[index];
        const sentence = segment.text;
        const segmentLocator = segment.ownerLocator ?? locator;
        const cacheKey = buildScopedSegmentCacheKey(
          segmentLocator,
          index,
          sentence,
          voice,
          effectiveNativeSpeed,
          configProviderRef,
          ttsModel,
          configProviderType,
          providerModelPolicy.supportsInstructions ? ttsInstructions : '',
          segment.key,
        );
        const requestKey = buildSegmentRequestKey(segmentLocator, index, sentence, segment.key);
        candidates.push({ sentence, segmentKey: segment.key, segmentIndex: index, locator: segmentLocator, requestKey, cacheKey });
      }
    }

    const uniqueCandidates: typeof candidates = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (seen.has(candidate.requestKey)) continue;
      seen.add(candidate.requestKey);
      if (segmentManifestCacheRef.current.has(candidate.cacheKey)) continue;
      const cooldownRetryAtMs = segmentRetryCooldownRef.current.get(candidate.cacheKey);
      if (shouldDeferSegmentRetry(Date.now(), cooldownRetryAtMs)) continue;
      if (preloadRequests.current.has(candidate.requestKey)) continue;
      uniqueCandidates.push(candidate);
    }
    if (uniqueCandidates.length === 0) return;

    const controller = new AbortController();
    activeAbortControllers.current.add(controller);
    const reqHeaders: TTSRequestHeaders = {
      'Content-Type': 'application/json',
      'x-openai-key': openApiKey || '',
      'x-tts-provider': configProviderRef,
    };
    if (openApiBaseUrl) {
      reqHeaders['x-openai-base-url'] = openApiBaseUrl;
    }

    const retryOptions: TTSRetryOptions = {
      maxRetries: 2,
      initialDelay: 300,
      maxDelay: 300,
    };
    const payload = uniqueCandidates.map((candidate) => ({
      segmentIndex: candidate.segmentIndex,
      ...(candidate.segmentKey ? { segmentKey: candidate.segmentKey } : {}),
      text: candidate.sentence,
      locator: candidate.locator,
    }));
    const candidateLookup = new Map<string, typeof uniqueCandidates[number]>();
    const candidateLookupKey = (segmentIndex: number, segmentKey?: string | null) =>
      `${segmentIndex}|${segmentKey || ''}`;
    for (const candidate of uniqueCandidates) {
      candidateLookup.set(candidateLookupKey(candidate.segmentIndex, candidate.segmentKey), candidate);
    }
    const preloadPromise = (async (): Promise<void> => {
      try {
        onTTSStart();
        const persistResult = await resolveSegmentsForPersist(payload);
        const persistPayload = persistResult.segments;
        if (persistPayload.length === 0) return;
        const ensured = await withRetry(
          async () => ensureTtsSegments({
            documentId,
            settings: {
              providerRef: configProviderRef,
              providerType: configProviderType,
              ttsModel,
              voice,
              nativeSpeed: effectiveNativeSpeed,
              ...(providerModelPolicy.supportsInstructions && ttsInstructions ? { ttsInstructions } : {}),
            },
            segments: persistPayload,
          }, reqHeaders, controller.signal),
          retryOptions,
        );

        ensured.segments.forEach((segment, persistIndex) => {
          const sourceIndex = persistResult.sourceIndices[persistIndex];
          if (sourceIndex === undefined) return;
          const candidate = uniqueCandidates[sourceIndex]
            ?? candidateLookup.get(candidateLookupKey(segment.segmentIndex, segment.segmentKey));
          if (!candidate) return;
          cacheCompletedManifestForCandidate(candidate.cacheKey, segment, alignmentEnabledForCurrentDoc);
        });
      } finally {
        activeAbortControllers.current.delete(controller);
        onTTSComplete();
      }
    })();

    for (const candidate of uniqueCandidates) {
      const candidatePromise: Promise<TTSSegmentPlaybackSource | null> = preloadPromise.then(() => {
        const manifest = segmentManifestCacheRef.current.get(candidate.cacheKey);
        if (!manifest || manifest.status !== 'completed' || !manifest.audioPresignUrl || !manifest.audioFallbackUrl) {
          return null;
        }
        warmSegmentAudioUrl(candidate.requestKey, manifest.audioPresignUrl, manifest.audioFallbackUrl);
        return {
          presignUrl: manifest.audioPresignUrl,
          fallbackUrl: manifest.audioFallbackUrl,
          manifest,
        };
      });
      // Background preload is best-effort; aborted batches should not surface as
      // unhandled promise rejections in dev.
      void candidatePromise.catch(() => {});
      preloadRequests.current.set(candidate.requestKey, candidatePromise);
    }

    void preloadPromise
      .catch((error) => {
        const status = (() => {
          if (typeof error === 'object' && error !== null && 'status' in error) {
            const maybe = (error as { status?: unknown }).status;
            return typeof maybe === 'number' ? maybe : undefined;
          }
          return undefined;
        })();
        const code = (() => {
          if (typeof error === 'object' && error !== null && 'code' in error) {
            const maybe = (error as { code?: unknown }).code;
            return typeof maybe === 'string' ? maybe : undefined;
          }
          return undefined;
        })();
        if (!isAbortLikeError(error) && !(status === 429 && code === 'USER_DAILY_QUOTA_EXCEEDED')) {
          console.error('Error preloading batched segments:', error);
        }
      })
      .finally(() => {
        for (const candidate of uniqueCandidates) {
          preloadRequests.current.delete(candidate.requestKey);
        }
      });
  }, [
    isAtLimit,
    documentId,
    isEPUB,
    segmentPreloadDepthPages,
    segmentPreloadSentenceLookahead,
    ttsSegmentMaxBlockLength,
    currDocPage,
    currDocPageNumber,
    currentReaderType,
    currentIndex,
    sentences,
    playbackSegments,
    voice,
    effectiveNativeSpeed,
    configProviderRef,
    configProviderType,
    ttsModel,
    openApiKey,
    openApiBaseUrl,
    providerModelPolicy.supportsInstructions,
    ttsInstructions,
    onTTSStart,
    onTTSComplete,
    processSentence,
    cacheCompletedManifestForCandidate,
    isAbortLikeError,
    pdfHighlightEnabled,
    pdfWordHighlightEnabled,
    epubHighlightEnabled,
    epubWordHighlightEnabled,
    resolveSegmentsForPersist,
    warmSegmentAudioUrl,
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
    // Single synchronous guard: covers the entire window from when playAudio() is
    // called until the Howl finishes (onend/onstop/error). React state guards
    // (isProcessing, activeHowl) are async and leave a micro-task gap that allows
    // the effect to re-fire and start duplicate playback — especially in Firefox
    // where HTML5 Audio events can trigger extra renders.
    if (playbackInFlightRef.current) return;
    playbackInFlightRef.current = true;

    // Start playing current sentence
    playAudio();

    // Start background lookahead preloading for upcoming sentences.
    preloadNextAudio();

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
    playAudio,
    preloadNextAudio,
    abortAudio
  ]);

  /**
   * Stops the current audio playback and resets all state
   */
  const stop = useCallback(() => {
    // Cancel any ongoing request
    invalidatePlaybackRun();
    abortAudio();
    clearWarmAudioCache();
    playbackInFlightRef.current = false;
    pendingJumpTargetRef.current = null;
    clearPendingEpubJump();
    bumpEpubPreloadGeneration();
    plannedSegmentsByLocationRef.current.clear();
    currentSourceUnitRef.current = null;
    currentSourceContextUnitsRef.current = [];
    completedEpubBoundarySegmentRef.current = null;
    pageFirstBlockFingerprintRef.current.clear();
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
  }, [abortAudio, clearWarmAudioCache, invalidatePlaybackRun, clearPendingEpubJump, bumpEpubPreloadGeneration]);

  const clearSegmentCaches = useCallback(() => {
    // Keep the current viewport/sentence list intact, but force all audio/manifest
    // state to be re-resolved after a server-side clear.
    abortAudio(true);
    segmentManifestCacheRef.current.clear();
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
      pendingEpubJumpRef.current = {
        index: Math.max(0, index),
        epoch: epubJumpEpochRef.current,
      };
      pendingJumpTargetRef.current = null;
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
    setActiveHowl(null);

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
    setActiveHowl(null);

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
    setActiveHowl(null);

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
    clearSegmentCaches,
    skipToLocation,
    registerLocationChangeHandler,
    registerEpubLocationWalker,
    registerEpubLocatorResolver,
    registerVisualPageChangeHandler,
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
    clearSegmentCaches,
    skipToLocation,
    registerLocationChangeHandler,
    registerEpubLocationWalker,
    registerEpubLocatorResolver,
    registerVisualPageChangeHandler,
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

  // Load last location on mount for EPUB/PDF/HTML.
  // Prefer server-backed progress when available, then fall back to local Dexie.
  useEffect(() => {
    if (!id) return;

    let cancelled = false;
    const docId = id as string;

    const applyLocation = (lastLocation: string) => {
      if (isEPUB && locationChangeHandlerRef.current) {
        // For EPUB documents, use the location change handler
        locationChangeHandlerRef.current(lastLocation);
        return;
      }

      if (!isEPUB) {
        // HTML stores "html:<location>:<sentenceIndex>".
        // PDF stores "<page>:<sentenceIndex>".
        try {
          if (currentReaderType === 'html') {
            const htmlMatch = /^html:([^:]+):(\d+)$/.exec(lastLocation);
            if (htmlMatch) {
              const [, rawLocation, sentenceIndexStr] = htmlMatch;
              const decodedLocation = decodeURIComponent(rawLocation);
              const parsedNumber = Number(decodedLocation);
              const location: TTSLocation = Number.isFinite(parsedNumber) && decodedLocation.trim() !== ''
                ? parsedNumber
                : decodedLocation || 1;
              const sentenceIndex = parseInt(sentenceIndexStr, 10);
              if (!isNaN(sentenceIndex)) {
                setCurrDocPage(location);
                pendingJumpTargetRef.current = {
                  locationKey: normalizeLocationKey(location),
                  index: Math.max(0, sentenceIndex),
                };
                return;
              }
            }
          }

          // Backward-compatible parser for legacy non-EPUB progress format.
          const [pageStr, sentenceIndexStr] = lastLocation.split(':');
          const page = parseInt(pageStr, 10);
          const sentenceIndex = parseInt(sentenceIndexStr, 10);
          if (!isNaN(page) && !isNaN(sentenceIndex)) {
            setCurrDocPage(page);
            pendingJumpTargetRef.current = {
              locationKey: normalizeLocationKey(page),
              index: Math.max(0, sentenceIndex),
            };
          }
        } catch (error) {
          console.warn('Error parsing non-EPUB location:', error);
        }
      }
    };

    const load = async () => {
      try {
        const local = await getLastDocumentLocation(docId);
        if (!cancelled && local) {
          applyLocation(local);
        }
      } catch (error) {
        console.warn('Error loading local last location:', error);
      }

      try {
        const remote = await getDocumentProgress(docId);
        if (!cancelled && remote?.location) {
          await setLastDocumentLocation(docId, remote.location).catch((error) => {
            console.warn('Error caching remote location locally:', error);
          });
          applyLocation(remote.location);
        }
      } catch (error) {
        console.warn('Error loading remote progress:', error);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [id, isEPUB, currentReaderType]);

  // Save current position periodically for non-EPUB readers.
  useEffect(() => {
    if (id && !isEPUB && sentences.length > 0) {
      const location = currentReaderType === 'html'
        ? `html:${encodeURIComponent(String(currDocPage || 1))}:${currentIndex}`
        : `${currDocPageNumber}:${currentIndex}`;
      const timeoutId = setTimeout(() => {
        setLastDocumentLocation(id as string, location).catch(error => {
          console.warn('Error saving non-EPUB location:', error);
        });
        scheduleDocumentProgressSync({
          documentId: id as string,
          readerType: currentReaderType,
          location,
        });
      }, 1000); // Debounce saves by 1 second

      return () => clearTimeout(timeoutId);
    }
  }, [id, isEPUB, currDocPage, currDocPageNumber, currentIndex, sentences.length, currentReaderType]);

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

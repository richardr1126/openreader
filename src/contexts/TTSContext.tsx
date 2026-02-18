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
import { useAudioCache } from '@/hooks/audio/useAudioCache';
import { useVoiceManagement } from '@/hooks/audio/useVoiceManagement';
import { useMediaSession } from '@/hooks/audio/useMediaSession';
import { useAudioContext } from '@/hooks/audio/useAudioContext';
import { getLastDocumentLocation, setLastDocumentLocation } from '@/lib/client/dexie';
import { getDocumentProgress, scheduleDocumentProgressSync } from '@/lib/client/api/user-state';
import { useBackgroundState } from '@/hooks/audio/useBackgroundState';
import { withRetry, generateTTS, alignAudio } from '@/lib/client/api/audiobooks';
import { preprocessSentenceForAudio, splitTextToTtsBlocks, splitTextToTtsBlocksEPUB } from '@/lib/shared/nlp';
import { isKokoroModel } from '@/lib/shared/kokoro';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';
import type {
  TTSLocation,
  TTSSmartMergeResult,
  TTSPageTurnEstimate,
  TTSPlaybackState,
  TTSSentenceAlignment,
  TTSAudioBuffer,
} from '@/types/tts';
import type {
  TTSRequestPayload,
  TTSRequestHeaders,
  TTSRetryOptions,
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
  availableVoices: string[];

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
  setText: (text: string, options?: boolean | SetTextOptions) => void;
  setCurrDocPages: (num: number | undefined) => void;
  setSpeedAndRestart: (speed: number) => void;
  setAudioPlayerSpeedAndRestart: (speed: number) => void;
  setVoiceAndRestart: (voice: string) => void;
  skipToLocation: (location: TTSLocation, shouldPause?: boolean) => void;
  registerLocationChangeHandler: (handler: (location: TTSLocation) => void) => void;  // EPUB-only: Handles chapter navigation
  registerVisualPageChangeHandler: (handler: (location: TTSLocation) => void) => void;
  setIsEPUB: (isEPUB: boolean) => void;
}

interface SetTextOptions {
  shouldPause?: boolean;
  location?: TTSLocation;
  nextLocation?: TTSLocation;
  nextText?: string;
}

const CONTINUATION_LOOKAHEAD = 600;
const SENTENCE_ENDING = /[.?!…]["'”’)\]]*\s*$/;
const wordHighlightFeatureEnabled =
  process.env.NEXT_PUBLIC_ENABLE_WORD_HIGHLIGHT?.toLowerCase() !== 'false';

// Tiny silent WAV used to unlock HTML5 audio on iOS/Safari.
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

const normalizeLocationKey = (location: TTSLocation) =>
  typeof location === 'number' ? `num:${location}` : `str:${location}`;

const isWhitespaceChar = (char: string) => /\s/.test(char);

const skipWhitespace = (source: string, start: number) => {
  let index = start;
  while (index < source.length && isWhitespaceChar(source[index])) {
    index++;
  }
  return index;
};

const matchNormalizedPrefixLength = (text: string, prefix: string): number | null => {
  let textIndex = 0;
  let prefixIndex = 0;

  while (prefixIndex < prefix.length) {
    const prefixChar = prefix[prefixIndex];

    if (isWhitespaceChar(prefixChar)) {
      prefixIndex = skipWhitespace(prefix, prefixIndex);
      textIndex = skipWhitespace(text, textIndex);
      continue;
    }

    if (textIndex >= text.length) {
      return null;
    }

    const textChar = text[textIndex];

    if (textChar === prefixChar || textChar.toLowerCase() === prefixChar.toLowerCase()) {
      textIndex++;
      prefixIndex++;
      continue;
    }

    return null;
  }

  return textIndex;
};

const needsSentenceContinuation = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return !SENTENCE_ENDING.test(trimmed);
};

const stripContinuationPrefix = (text: string, prefix: string) => {
  if (!prefix) return { text, removed: false };

  // Try literal match first since PDF text is normalized already
  if (text.startsWith(prefix)) {
    return {
      text: text.slice(prefix.length).trimStart(),
      removed: true,
    };
  }

  const trimmedPrefix = prefix.trimStart();
  const trimmedText = text.trimStart();

  if (trimmedText.startsWith(trimmedPrefix)) {
    const offset = text.length - trimmedText.length;
    return {
      text: text.slice(offset + trimmedPrefix.length).trimStart(),
      removed: true,
    };
  }

  const matchedLength = matchNormalizedPrefixLength(text, prefix);
  if (matchedLength !== null) {
    return {
      text: text.slice(matchedLength).trimStart(),
      removed: true,
    };
  }

  return { text, removed: false };
};

const extractContinuationSlice = (nextText: string): TTSSmartMergeResult | null => {
  if (!nextText?.trim()) {
    return null;
  }

  const snippet = nextText.trim().slice(0, CONTINUATION_LOOKAHEAD);
  let boundaryIndex = -1;

  for (let i = 0; i < snippet.length; i++) {
    const char = snippet[i];
    if (/[.?!…]/.test(char)) {
      let j = i + 1;
      while (j < snippet.length && /["'”’)\]]/.test(snippet[j])) {
        j++;
      }
      while (j < snippet.length && /\s/.test(snippet[j])) {
        j++;
      }
      boundaryIndex = j;
      break;
    }
  }

  if (boundaryIndex === -1) {
    return null;
  }

  const rawSlice = snippet.slice(0, boundaryIndex);
  const addition = rawSlice.trim();

  if (!addition) {
    return null;
  }

  return {
    text: addition,
    carried: rawSlice,
  };
};

const mergeContinuation = (text: string, nextText: string): TTSSmartMergeResult | null => {
  if (!needsSentenceContinuation(text)) {
    return null;
  }

  const slice = extractContinuationSlice(nextText);
  if (!slice) {
    return null;
  }

  const trimmed = text.trimEnd();
  const endsWithHyphen = trimmed.endsWith('-');
  const base = endsWithHyphen ? trimmed.slice(0, -1) : trimmed;
  const joiner = endsWithHyphen ? '' : (base ? ' ' : '');
  const mergedText = `${base}${joiner}${slice.text}`.trim();

  return {
    text: mergedText,
    carried: slice.carried,
  };
};

const buildCacheKey = (
  sentence: string,
  voice: string,
  speed: number,
  provider: string,
  model: string,
) => {
  return [
    `provider=${provider || ''}`,
    `model=${model || ''}`,
    `voice=${voice || ''}`,
    `speed=${Number.isFinite(speed) ? speed : ''}`,
    `text=${sentence}`,
  ].join('|');
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
    ttsProvider: configTTSProvider,
    ttsModel: configTTSModel,
    ttsInstructions: configTTSInstructions,
    updateConfigKey,
    skipBlank,
    smartSentenceSplitting,
    pdfHighlightEnabled,
    pdfWordHighlightEnabled,
    epubHighlightEnabled,
    epubWordHighlightEnabled,
  } = useConfig();

  // Audio and voice management hooks
  const audioContext = useAudioContext();
  const audioCache = useAudioCache(25);
  const { availableVoices, fetchVoices } = useVoiceManagement(openApiKey, openApiBaseUrl, configTTSProvider, configTTSModel);
  const {
    authEnabled,
    onTTSStart,
    onTTSComplete,
    refresh: refreshRateLimit,
    triggerRateLimit,
    isAtLimit,
  } = useAuthRateLimit();

  // Add ref for location change handler
  const locationChangeHandlerRef = useRef<((location: TTSLocation) => void) | null>(null);
  const visualPageChangeHandlerRef = useRef<((location: TTSLocation) => void) | null>(null);

  /**
   * Registers a handler function for location changes in EPUB documents
   * This is only used for EPUB documents to handle chapter navigation
   * 
   * @param {Function} handler - Function to handle location changes
   */
  const registerLocationChangeHandler = useCallback((handler: (location: TTSLocation) => void) => {
    locationChangeHandlerRef.current = handler;
  }, []);

  /**
   * Registers a handler function for visual page changes in EPUB documents
   * This is only used for EPUB documents to handle visual page navigation
   * 
   * @param {Function} handler - Function to handle visual page changes
   */
  const registerVisualPageChangeHandler = useCallback((handler: (location: TTSLocation) => void) => {
    visualPageChangeHandlerRef.current = handler;
  }, []);

  // Get document ID from URL params
  const { id } = useParams();
  const pathname = usePathname();

  const currentReaderType: ReaderType = useMemo(() => {
    if (pathname.startsWith('/epub/')) return 'epub';
    if (pathname.startsWith('/html/')) return 'html';
    return 'pdf';
  }, [pathname]);

  /**
   * State Management
   */
  const [isPlaying, setIsPlaying] = useState(false);
  const [isEPUB, setIsEPUB] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const [currDocPage, setCurrDocPage] = useState<TTSLocation>(1);
  const currDocPageNumber = (!isEPUB ? parseInt(currDocPage.toString()) : 1); // PDF uses numbers only
  const [currDocPages, setCurrDocPages] = useState<number>();

  const [sentences, setSentences] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [activeHowl, setActiveHowl] = useState<Howl | null>(null);
  const [speed, setSpeed] = useState(voiceSpeed);
  const [audioSpeed, setAudioSpeed] = useState(audioPlayerSpeed);
  const [voice, setVoice] = useState(configVoice);
  const [ttsModel, setTTSModel] = useState(configTTSModel);
  const [ttsInstructions, setTTSInstructions] = useState(configTTSInstructions);

  // Track pending preload requests
  const preloadRequests = useRef<Map<string, Promise<string>>>(new Map());
  // Track active abort controllers for TTS requests
  const activeAbortControllers = useRef<Set<AbortController>>(new Set());
  // Track if we're restoring from a saved position
  const [pendingRestoreIndex, setPendingRestoreIndex] = useState<number | null>(null);
  // Guard to coalesce rapid restarts and only resume the latest change
  const restartSeqRef = useRef(0);
  // Track continuation slices for PDF/EPUB page transitions
  const continuationCarryRef = useRef<Map<string, string>>(new Map());
  const epubContinuationRef = useRef<string | null>(null);
  const pageTurnEstimateRef = useRef<TTSPageTurnEstimate | null>(null);
  const pageTurnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentenceAlignmentCacheRef = useRef<Map<string, TTSSentenceAlignment>>(new Map());
  const [currentSentenceAlignment, setCurrentSentenceAlignment] = useState<TTSSentenceAlignment | undefined>();
  const [currentWordIndex, setCurrentWordIndex] = useState<number | null>(null);
  const sentencesRef = useRef<string[]>([]);
  const currentIndexRef = useRef(0);

  const audioUnlockAttemptRef = useRef(0);

  // Safari/iOS (HTML5 audio) can spontaneously reset playbackRate to 1. Keep re-applying
  // the desired rate while a sentence is playing.
  const rateWatchdogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearRateWatchdog = useCallback(() => {
    if (!rateWatchdogIntervalRef.current) return;
    clearInterval(rateWatchdogIntervalRef.current);
    rateWatchdogIntervalRef.current = null;
  }, []);

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

  useEffect(() => {
    sentencesRef.current = sentences;
  }, [sentences]);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  /**
   * Processes text into sentences using the shared NLP utility
   * 
   * @param {string} text - The text to be processed
   * @returns {Promise<string[]>} Array of processed sentences
   */
  const splitTextToTtsBlocksLocal = useCallback(async (text: string): Promise<string[]> => {
    if (text.length < 1) {
      return [];
    }

    // Use the shared utility directly instead of making an API call
    return isEPUB ? splitTextToTtsBlocksEPUB(text) : splitTextToTtsBlocks(text);
  }, [isEPUB]);

  /**
   * Stops the current audio playback and clears the active Howl instance
   * @param {boolean} [clearPending=false] - Whether to clear pending requests
   */
  const abortAudio = useCallback((clearPending = false) => {
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
    }

    if (pageTurnTimeoutRef.current) {
      clearTimeout(pageTurnTimeoutRef.current);
      pageTurnTimeoutRef.current = null;
    }
    setCurrentWordIndex(null);
  }, [activeHowl, clearRateWatchdog]);

  /**
   * Pauses the current audio playback
   * Used for external control of playback state
   */
  const pause = useCallback(() => {
    abortAudio();
    setIsPlaying(false);
  }, [abortAudio]);

  /**
   * Navigates to a specific location in the document
   * Works for both PDF pages and EPUB locations
   * 
   * @param {string | number} location - The target location to navigate to
   * @param {boolean} shouldPause - Whether to pause playback
   */
  const skipToLocation = useCallback((location: TTSLocation, shouldPause = false) => {
    // Reset state for new content in correct order
    abortAudio();
    if (shouldPause) setIsPlaying(false);
    setCurrentIndex(0);
    setSentences([]);
    setCurrDocPage(location);

  }, [abortAudio]);

  /**
   * Moves to the next or previous sentence
   * 
   * @param {boolean} [backwards=false] - Whether to move backwards
   */
  const advance = useCallback(async (backwards = false) => {
    const nextIndex = currentIndex + (backwards ? -1 : 1);

    // Handle within current page bounds
    if (nextIndex < sentences.length && nextIndex >= 0) {
      setCurrentIndex(nextIndex);
      return;
    }

    // For EPUB documents, always try to advance to next/prev section
    if (isEPUB && locationChangeHandlerRef.current) {
      locationChangeHandlerRef.current(nextIndex >= sentences.length ? 'next' : 'prev');
      return;
    }

    // For PDFs and other documents, check page bounds
    if (!isEPUB) {
      // Handle next/previous page transitions
      if ((nextIndex >= sentences.length && currDocPageNumber < currDocPages!) ||
        (nextIndex < 0 && currDocPageNumber > 1)) {
        // Pass wasPlaying to maintain playback state during page turn
        skipToLocation(currDocPageNumber + (nextIndex >= sentences.length ? 1 : -1));
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

    let workingText = text;

    // Apply or clear sentence continuation logic based on config
    let continuationCarried: string | undefined;
    if (smartSentenceSplitting) {
      if (isEPUB && epubContinuationRef.current) {
        const { text: strippedText, removed } = stripContinuationPrefix(workingText, epubContinuationRef.current);
        workingText = strippedText;
        if (removed) {
          epubContinuationRef.current = null;
        }
      }

      if (!isEPUB && normalizedOptions.location !== undefined) {
        const key = normalizeLocationKey(normalizedOptions.location);
        const carried = continuationCarryRef.current.get(key);
        if (carried) {
          const { text: strippedText, removed } = stripContinuationPrefix(workingText, carried);
          workingText = strippedText;
          if (removed) {
            continuationCarryRef.current.delete(key);
          }
        }
      }

      if (normalizedOptions.nextText) {
        const merged = mergeContinuation(workingText, normalizedOptions.nextText);
        if (merged) {
          workingText = merged.text;
          continuationCarried = merged.carried;
        }
      }

      if (continuationCarried) {
        if (isEPUB) {
          epubContinuationRef.current = continuationCarried;
        } else if (normalizedOptions.nextLocation !== undefined) {
          continuationCarryRef.current.set(
            normalizeLocationKey(normalizedOptions.nextLocation),
            continuationCarried
          );
        }
      }
    } else {
      // When disabled, clear any stale continuation state
      epubContinuationRef.current = null;
      continuationCarryRef.current.clear();
      pageTurnEstimateRef.current = null;
    }

    // Check for blank section after adjustments
    if (handleBlankSection(workingText)) return;

    const shouldPause = normalizedOptions.shouldPause ?? false;

    // Keep track of previous state and pause playback
    const wasPlaying = isPlaying;
    setIsPlaying(false);
    abortAudio(true); // Clear pending requests since text is changing
    setIsProcessing(true); // Set processing state before text processing starts

    splitTextToTtsBlocksLocal(workingText)
      .then(newSentences => {
        if (newSentences.length === 0) {
          console.warn('No sentences found in text');
          setIsProcessing(false);
          return;
        }

        // Set all state updates in a predictable order
        setSentences(newSentences);

        // Check if we have a pending restore index for PDF
        if (pendingRestoreIndex !== null && !isEPUB) {
          const restoreIndex = Math.min(pendingRestoreIndex, newSentences.length - 1);
          console.log(`Restoring sentence index: ${restoreIndex}`);
          setCurrentIndex(restoreIndex);
          setPendingRestoreIndex(null); // Clear the pending restore
        } else {
          setCurrentIndex(0);
        }

        // Reset alignment state whenever the text block changes
        sentenceAlignmentCacheRef.current.clear();
        setCurrentSentenceAlignment(undefined);
        setCurrentWordIndex(null);

        // Compute auto page-turn estimate for PDFs when we have a continuation
        if (smartSentenceSplitting && !isEPUB && continuationCarried && normalizedOptions.nextLocation !== undefined) {
          const continuationNormalized = preprocessSentenceForAudio(continuationCarried);
          if (continuationNormalized) {
            let bestEstimate: TTSPageTurnEstimate | null = null;

            newSentences.forEach((sentence, index) => {
              const normalizedSentence = preprocessSentenceForAudio(sentence);
              if (!normalizedSentence) return;

              if (!normalizedSentence.toLowerCase().endsWith(continuationNormalized.toLowerCase())) return;

              const totalLength = normalizedSentence.length;
              const continuationLength = continuationNormalized.length;
              if (totalLength <= continuationLength) return;

              const baseLength = totalLength - continuationLength;
              const fraction = baseLength / totalLength;
              if (fraction <= 0 || fraction >= 1) return;

              bestEstimate = {
                location: normalizedOptions.nextLocation!,
                sentenceIndex: index,
                fraction,
              };
            });

            pageTurnEstimateRef.current = bestEstimate;
          } else {
            pageTurnEstimateRef.current = null;
          }
        } else {
          pageTurnEstimateRef.current = null;
        }

        setIsProcessing(false);

        // Restore playback state if needed
        if (!shouldPause && wasPlaying) {
          setIsPlaying(true);
        }
      })
      .catch(error => {
        console.warn('Error processing text:', error);
        setIsProcessing(false);
        toast.error('Failed to process text', {
          duration: 3000,
        });
      });
  }, [isPlaying, handleBlankSection, abortAudio, splitTextToTtsBlocksLocal, pendingRestoreIndex, isEPUB, smartSentenceSplitting]);

  /**
   * Toggles the playback state between playing and paused
   */
  const togglePlay = useCallback(() => {
    if (isPlaying) {
      abortAudio();
      setIsPlaying(false);
      return;
    }

    // Ensure audio is unlocked while we're still in the click/tap handler.
    unlockPlaybackOnUserGesture();
    setIsPlaying(true);
  }, [abortAudio, isPlaying, unlockPlaybackOnUserGesture]);


  /**
   * Moves forward one sentence in the text
   */
  const skipForward = useCallback(async () => {
    // Only show processing state if we're currently playing
    if (isPlaying) {
      setIsProcessing(true);
    }
    abortAudio(false); // Don't clear pending requests
    await advance();
  }, [isPlaying, abortAudio, advance]);

  /**
   * Moves backward one sentence in the text
   */
  const skipBackward = useCallback(async () => {
    // Only show processing state if we're currently playing
    if (isPlaying) {
      setIsProcessing(true);
    }
    abortAudio(false); // Don't clear pending requests
    await advance(true);
  }, [isPlaying, abortAudio, advance]);

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

  /**
   * Validates that the current voice is in the available voices list
   * If voice is empty or invalid, use the first available voice (only in local state, don't save)
   */
  useEffect(() => {
    if (availableVoices.length > 0) {
      // Allow Kokoro multi-voice strings (e.g., "voice1(0.5)+voice2(0.5)") for any provider
      const isKokoro = isKokoroModel(configTTSModel);

      if (isKokoro) {
        // If Kokoro and we have any voice string (including plus/weights), don't override it.
        // Only default when voice is empty.
        if (!voice) {
          setVoice(availableVoices[0]);
        }
        return;
      }

      if (!voice || !availableVoices.includes(voice)) {
        console.log(`Voice "${voice || '(empty)'}" not found in available voices. Using "${availableVoices[0]}"`);
        setVoice(availableVoices[0]);
        // Don't save to config - just use it temporarily until user explicitly selects one
      }
    }
  }, [availableVoices, voice, configTTSModel]);

  /**
   * Generates and plays audio for the current sentence
   * 
   * @param {string} sentence - The sentence to generate audio for
   * @returns {Promise<TTSAudioBuffer | undefined>} The generated audio buffer
   */
  const getAudio = useCallback(async (sentence: string, preload = false): Promise<TTSAudioBuffer | undefined> => {
    const alignmentEnabledForCurrentDoc =
      wordHighlightFeatureEnabled &&
      ((!isEPUB && pdfHighlightEnabled && pdfWordHighlightEnabled) ||
        (isEPUB && epubHighlightEnabled && epubWordHighlightEnabled));
    // Helper to ensure we have an alignment for a given
    // sentence/audio pair, even when the audio itself is
    // served from the local cache.
    const ensureAlignment = (arrayBuffer: TTSAudioBuffer) => {
      if (!alignmentEnabledForCurrentDoc) return;
      const alignmentKey = buildCacheKey(
        sentence,
        voice,
        speed,
        configTTSProvider,
        ttsModel,
      );
      if (sentenceAlignmentCacheRef.current.has(alignmentKey)) return;

      try {
        const audioBytes = Array.from(new Uint8Array(arrayBuffer));
        const alignmentBody = {
          text: sentence,
          audio: audioBytes,
        };

        void alignAudio(alignmentBody)
          .then(async (data) => {
            if (!data || !Array.isArray(data.alignments) || !data.alignments[0]) {
              return;
            }
            const alignment = data.alignments[0] as TTSSentenceAlignment;
            sentenceAlignmentCacheRef.current.set(alignmentKey, alignment);

            const currentSentence = sentencesRef.current[currentIndexRef.current];
            if (currentSentence === sentence) {
              setCurrentSentenceAlignment(alignment);
              setCurrentWordIndex(null);
            }
          })
          .catch((err) => {
            console.warn('Alignment request failed:', err);
          });
      } catch (err) {
        console.warn('Failed to start alignment request:', err);
      }
    };

    const audioCacheKey = buildCacheKey(
      sentence,
      voice,
      speed,
      configTTSProvider,
      ttsModel,
    );

    // Check if the audio is already cached
    const cachedAudio = audioCache.get(audioCacheKey);
    if (cachedAudio) {
      console.log('Using cached audio for sentence:', sentence.substring(0, 20));
      // If we have audio but no alignment (e.g. after a
      // navigation or TTS reset), kick off a fresh alignment
      // request using the cached audio buffer.
      ensureAlignment(cachedAudio);
      return cachedAudio;
    }

    // If the user is already out of quota, avoid spamming requests.
    // Cached audio above is still allowed to play.
    if (isAtLimit) {
      if (!preload) {
        setIsPlaying(false);
      }
      return undefined;
    }

    try {
      console.log('Requesting audio for sentence:', sentence);

      // Create an AbortController for this request
      const controller = new AbortController();
      activeAbortControllers.current.add(controller);

      const reqHeaders: TTSRequestHeaders = {
        'Content-Type': 'application/json',
        'x-openai-key': openApiKey || '',
        'x-tts-provider': configTTSProvider,
      };
      if (openApiBaseUrl) {
        reqHeaders['x-openai-base-url'] = openApiBaseUrl;
      }

      const reqBody: TTSRequestPayload = {
        text: sentence,
        voice,
        speed,
        model: ttsModel,
        instructions: ttsModel === 'gpt-4o-mini-tts' ? ttsInstructions : undefined,
      };

      const retryOptions: TTSRetryOptions = {
        maxRetries: 3,
        initialDelay: 1000,
        maxDelay: 5000,
        backoffFactor: 2
      };

      onTTSStart();
      let arrayBuffer: TTSAudioBuffer;
      try {
        arrayBuffer = await withRetry(
          async () => {
            return await generateTTS(reqBody, reqHeaders, controller.signal);
          },
          retryOptions
        );
      } finally {
        onTTSComplete();
      }

      // Remove the controller once the request is complete
      activeAbortControllers.current.delete(controller);

      // Cache the array buffer
      audioCache.set(audioCacheKey, arrayBuffer);

      // Fire-and-forget alignment request; do not block audio playback
      ensureAlignment(arrayBuffer);

      return arrayBuffer;
    } catch (error) {
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

      // Check if this was an abort error
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('TTS request aborted:', sentence.substring(0, 20));
        return;
      }

      // If a preload request fails, we should not flip the global playback state.
      // Otherwise the UI can lose the pause button while the current sentence
      // continues playing.
      if (!preload) {
        setIsPlaying(false);
      }

      // Handle daily quota exceeded (429 + Problem Details code)
      if (status === 429 && code === 'USER_DAILY_QUOTA_EXCEEDED') {
        // Avoid noisy toasts from background preloading; keep the user-facing error for active playback.
        if (!preload) {
          toast.error('Daily TTS limit reached.', {
            id: 'tts-limit-error',
            duration: 5000,
          });
        }
        triggerRateLimit();
        refreshRateLimit().catch(console.error);
        // Do NOT re-throw, just return undefined to stop playback gracefully
        return undefined;
      }

      // Avoid noisy toasts from background preloading.
      if (!preload) {
        toast.error('TTS failed. Skipped sentence and paused.', {
          id: 'tts-api-error',
          duration: 7000,
        });
      }
      throw error;
    }
  }, [
    voice,
    speed,
    ttsModel,
    ttsInstructions,
    audioCache,
    openApiKey,
    openApiBaseUrl,
    configTTSProvider,
    isEPUB,
    pdfHighlightEnabled,
    pdfWordHighlightEnabled,
    epubHighlightEnabled,
    epubWordHighlightEnabled,
    triggerRateLimit,
    refreshRateLimit,
    onTTSComplete,
    onTTSStart,
    isAtLimit
  ]);

  /**
   * Processes and plays the current sentence
   * 
   * @param {string} sentence - The sentence to process
   * @param {boolean} [preload=false] - Whether this is a preload request
   * @returns {Promise<string>} The URL of the processed audio
   */
  const processSentence = useCallback(async (sentence: string, preload = false): Promise<string> => {
    if (!audioContext) throw new Error('Audio context not initialized');

    // Check if there's a pending preload request for this sentence
    const pendingRequest = preloadRequests.current.get(sentence);
    if (pendingRequest) {
      console.log('Using pending preload request for:', sentence.substring(0, 20));
      setIsProcessing(true); // Show processing state when using pending request
      // If this is not a preload request, remove it from the pending map
      if (!preload) {
        preloadRequests.current.delete(sentence);
      }
      return pendingRequest;
    }

    // Only set processing state if not preloading
    if (!preload) setIsProcessing(true);

    // Create the audio processing promise
    const processPromise = (async () => {
      try {
        const audioBuffer = await getAudio(sentence, preload);
        if (!audioBuffer) {
          // If quota or other handled error returns undefined, ensure we don't throw "No audio data"
          // Just return empty string to signal graceful failure/skip
          return '';
        }

        // Convert to base64 data URI
        const bytes = new Uint8Array(audioBuffer);
        const binaryString = bytes.reduce((acc, byte) => acc + String.fromCharCode(byte), '');
        const base64String = btoa(binaryString);
        return `data:audio/mp3;base64,${base64String}`;
      } catch (error) {
        setIsProcessing(false);
        throw error;
      }
    })();

    // If this is a preload request, store it in the map
    if (preload) {
      preloadRequests.current.set(sentence, processPromise);
      // Clean up the map entry once the promise resolves or rejects
      void processPromise
        .finally(() => {
          preloadRequests.current.delete(sentence);
        })
        .catch(() => {
          // Prevent unhandled rejections from the cleanup-only chained promise.
        });
    }

    return processPromise;
  }, [audioContext, getAudio]);

  /**
   * Plays the current sentence with Howl
   * 
   * @param {string} sentence - The sentence to play
   */
  const playSentenceWithHowl = useCallback(async (sentence: string, sentenceIndex: number) => {
    if (!sentence) {
      console.log('No sentence to play');
      setIsProcessing(false);
      return;
    }

    const MAX_RETRIES = 3;
    const INITIAL_RETRY_DELAY = 1000; // 1 second

    const createHowl = async (retryCount = 0): Promise<Howl | null> => {
      let playErrorAttempts = 0;
      // Get the processed audio data URI directly from processSentence
      const audioDataUri = await processSentence(sentence);
      if (!audioDataUri) {
        // Graceful exit for rate limit / abort / intentionally skipped sentence
        console.log('Skipping playback for sentence (no audio generated)');
        return null;
      }

      // Force unload any previous Howl instance to free up resources
      if (activeHowl) {
        activeHowl.unload();
      }

      return new Howl({
        src: [audioDataUri],
        format: ['mp3', 'mpeg'],
        html5: true,
        preload: true,
        // We never need overlapping playback for a single sentence. Keeping this low avoids
        // Safari/HTML5 Audio pool exhaustion when retries happen.
        pool: 1,
        rate: audioSpeed,
        onload: function (this: Howl) {
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
          setIsProcessing(false);
          startRateWatchdog(this);
          if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = 'playing';
          }
        },
        onplayerror: function (this: Howl, soundId, error) {
          const actualError = error ?? soundId;
          console.warn('Howl playback error:', actualError);

          // Common on iOS/Safari when the actual play() call happens after awaiting TTS.
          // Do not skip/advance in this case; just pause and tell the user to tap play again.
          if (isAutoplayBlockedError(actualError)) {
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
          const actualError = error ?? soundId;
          console.warn(`Error loading audio (attempt ${retryCount + 1}/${MAX_RETRIES}):`, actualError);

          if (retryCount < MAX_RETRIES) {
            // Calculate exponential backoff delay
            const delay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
            console.log(`Retrying in ${delay}ms...`);

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
              const retryHowl = await createHowl(retryCount + 1);
              if (retryHowl) {
                setActiveHowl(retryHowl);
                retryHowl.play();
              } else {
                // No audio generated (quota/abort). Stop cleanly without spamming errors.
                setIsProcessing(false);
                setActiveHowl(null);
                setIsPlaying(false);
              }
            } catch (err) {
              console.error('Error creating Howl instance:', err);
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
          clearRateWatchdog();
          this.unload();
          setActiveHowl(null);
          if (pageTurnTimeoutRef.current) {
            clearTimeout(pageTurnTimeoutRef.current);
            pageTurnTimeoutRef.current = null;
          }
          if (isPlaying) {
            advance();
          }
        },
        onstop: function (this: Howl) {
          clearRateWatchdog();
          setIsProcessing(false);
          this.unload();
        }
      });
    };

    try {
      const howl = await createHowl();
      if (!howl) {
        // No audio generated (quota hit / aborted / intentionally skipped). Stop cleanly without
        // advancing or spamming errors.
        setActiveHowl(null);
        setIsProcessing(false);
        setIsPlaying(false);
        return null;
      }

      setActiveHowl(howl);
      return howl;
    } catch (error) {
      console.error('Error playing TTS:', error);
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
    isAutoplayBlockedError,
    applyPlaybackRateToHowl,
    startRateWatchdog,
    clearRateWatchdog,
  ]);

  const playAudio = useCallback(async () => {
    const sentence = sentences[currentIndex];
    const alignmentKey = buildCacheKey(
      sentence,
      voice,
      speed,
      configTTSProvider,
      ttsModel,
    );
    const cachedAlignment = sentenceAlignmentCacheRef.current.get(alignmentKey);
    if (cachedAlignment) {
      setCurrentSentenceAlignment(cachedAlignment);
      setCurrentWordIndex(null);
    } else {
      setCurrentSentenceAlignment(undefined);
      setCurrentWordIndex(null);
    }

    const howl = await playSentenceWithHowl(sentence, currentIndex);
    if (howl) {
      howl.play();
    }
  }, [sentences, currentIndex, playSentenceWithHowl, voice, speed, configTTSProvider, ttsModel]);

  // Keep the current playback rate applied to the active Howl. Some browsers (notably
  // iOS Safari with HTML5 audio) can reset playbackRate after initial load/play.
  useEffect(() => {
    if (!activeHowl) return;
    applyPlaybackRateToHowl(activeHowl);
    if (isPlaying) {
      startRateWatchdog(activeHowl);
    }
  }, [activeHowl, audioSpeed, applyPlaybackRateToHowl, isPlaying, startRateWatchdog]);

  // Place useBackgroundState after playAudio is defined
  const isBackgrounded = useBackgroundState({
    activeHowl,
    isPlaying,
    playAudio,
  });

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
   * Preloads the next sentence's audio
   */
  const preloadNextAudio = useCallback(async () => {
    if (isAtLimit) return;
    try {
      const nextSentence = sentences[currentIndex + 1];
      if (nextSentence) {
        const nextKey = buildCacheKey(
          nextSentence,
          voice,
          speed,
          configTTSProvider,
          ttsModel,
        );

        if (!audioCache.has(nextKey) && !preloadRequests.current.has(nextSentence)) {
          // Start preloading but don't wait for it to complete
          processSentence(nextSentence, true).catch(error => {
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
            // Ignore quota errors during preload
            if (!(status === 429 && code === 'USER_DAILY_QUOTA_EXCEEDED')) {
              console.error('Error preloading next sentence:', error);
            }
          });
        }
      }
    } catch (error) {
      console.error('Error initiating preload:', error);
    }
  }, [isAtLimit, currentIndex, sentences, audioCache, processSentence, voice, speed, configTTSProvider, ttsModel]);

  /**
   * Main Playback Driver
   * Controls the flow of audio playback and sentence processing
   */
  useEffect(() => {
    if (!isPlaying) return; // Don't proceed if stopped
    if (isProcessing) return; // Don't proceed if processing audio
    if (!sentences[currentIndex]) return; // Don't proceed if no sentence to play
    if (activeHowl) return; // Don't proceed if audio is already playing
    if (isBackgrounded) return; // Don't proceed if backgrounded

    // Start playing current sentence
    playAudio();

    // Start preloading next sentence in parallel
    preloadNextAudio();

    return () => {
      // Only abort if we're actually stopping playback
      if (!isPlaying) {
        abortAudio();
      }
    };
  }, [
    isPlaying,
    isProcessing,
    currentIndex,
    sentences,
    activeHowl,
    isBackgrounded,
    playAudio,
    preloadNextAudio,
    abortAudio
  ]);

  /**
   * Stops the current audio playback and resets all state
   */
  const stop = useCallback(() => {
    // Cancel any ongoing request
    abortAudio();
    locationChangeHandlerRef.current = null;
    epubContinuationRef.current = null;
    continuationCarryRef.current.clear();
    setIsPlaying(false);
    setCurrentIndex(0);
    setSentences([]);
    setCurrDocPage(1);
    setCurrDocPages(undefined);
    setIsProcessing(false);
    setIsEPUB(false);
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
    abortAudio();

    // Same autoplay-unlock issue as togglePlay when starting from a fresh load.
    unlockPlaybackOnUserGesture();

    setCurrentIndex(index);
    setIsPlaying(true);
  }, [abortAudio, unlockPlaybackOnUserGesture]);

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
  }, [abortAudio, updateConfigKey, isPlaying]);

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
  }, [abortAudio, updateConfigKey, isPlaying]);

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
  }, [abortAudio, updateConfigKey, isPlaying]);

  /**
   * Provides the TTS context value to child components
   */
  const value = useMemo(() => ({
    isPlaying,
    isProcessing,
    isBackgrounded,
    currentSentence: sentences[currentIndex] || '',
    currentSentenceAlignment,
    currentWordIndex,
    currDocPage,
    currDocPageNumber,
    currDocPages,
    availableVoices,
    togglePlay,
    skipForward,
    skipBackward,
    stop,
    pause,
    stopAndPlayFromIndex,
    setText,
    setCurrDocPages,
    setSpeedAndRestart,
    setAudioPlayerSpeedAndRestart,
    setVoiceAndRestart,
    skipToLocation,
    registerLocationChangeHandler,
    registerVisualPageChangeHandler,
    setIsEPUB
  }), [
    isPlaying,
    isProcessing,
    isBackgrounded,
    sentences,
    currentIndex,
    currDocPage,
    currDocPageNumber,
    currDocPages,
    availableVoices,
    togglePlay,
    skipForward,
    skipBackward,
    stop,
    pause,
    stopAndPlayFromIndex,
    setText,
    setCurrDocPages,
    setSpeedAndRestart,
    setAudioPlayerSpeedAndRestart,
    setVoiceAndRestart,
    skipToLocation,
    registerLocationChangeHandler,
    registerVisualPageChangeHandler,
    setIsEPUB,
    currentSentenceAlignment,
    currentWordIndex
  ]);

  // Use media session hook
  useMediaSession({
    togglePlay,
    skipForward,
    skipBackward,
  });

  // Load last location on mount for both EPUB and PDF.
  // Prefer server-backed progress when available, then fall back to local Dexie.
  useEffect(() => {
    if (!id) return;

    let cancelled = false;
    const docId = id as string;

    const applyLocation = (lastLocation: string) => {
      console.log('Setting last location:', lastLocation);

      if (isEPUB && locationChangeHandlerRef.current) {
        // For EPUB documents, use the location change handler
        locationChangeHandlerRef.current(lastLocation);
        return;
      }

      if (!isEPUB) {
        // For PDF documents, parse the location as "page:sentence"
        try {
          const [pageStr, sentenceIndexStr] = lastLocation.split(':');
          const page = parseInt(pageStr, 10);
          const sentenceIndex = parseInt(sentenceIndexStr, 10);

          if (!isNaN(page) && !isNaN(sentenceIndex)) {
            console.log(`Restoring PDF position: page ${page}, sentence ${sentenceIndex}`);
            // Skip to the page first, then the sentence index will be restored when setText is called
            setCurrDocPage(page);
            // Store the sentence index to be used when text is loaded
            setPendingRestoreIndex(sentenceIndex);
          }
        } catch (error) {
          console.warn('Error parsing PDF location:', error);
        }
      }
    };

    const load = async () => {
      if (authEnabled) {
        try {
          const remote = await getDocumentProgress(docId);
          if (!cancelled && remote?.location) {
            await setLastDocumentLocation(docId, remote.location).catch((error) => {
              console.warn('Error caching remote location locally:', error);
            });
            applyLocation(remote.location);
            return;
          }
        } catch (error) {
          console.warn('Error loading remote progress:', error);
        }
      }

      try {
        const local = await getLastDocumentLocation(docId);
        if (!cancelled && local) {
          applyLocation(local);
        }
      } catch (error) {
        console.warn('Error loading local last location:', error);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [id, isEPUB, currentReaderType, authEnabled]);

  // Save current position periodically for PDFs
  useEffect(() => {
    if (id && !isEPUB && sentences.length > 0) {
      const location = `${currDocPageNumber}:${currentIndex}`;
      const timeoutId = setTimeout(() => {
        console.log(`Saving PDF position: ${location}`);
        setLastDocumentLocation(id as string, location).catch(error => {
          console.warn('Error saving PDF location:', error);
        });
        if (authEnabled) {
          scheduleDocumentProgressSync({
            documentId: id as string,
            readerType: currentReaderType,
            location,
          });
        }
      }, 1000); // Debounce saves by 1 second

      return () => clearTimeout(timeoutId);
    }
  }, [id, isEPUB, currDocPageNumber, currentIndex, sentences.length, currentReaderType, authEnabled]);

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

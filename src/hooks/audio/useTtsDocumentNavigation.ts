'use client';

import { useCallback, useEffect, type MutableRefObject } from 'react';
import toast from 'react-hot-toast';

import {
  pdfAnchorPage,
  resolveFirstPlanIndexForDocumentAnchor,
  type PlaybackAnchor,
} from '@/lib/client/tts/playback-selection';
import type { TTSSegmentLocator } from '@/types/client';
import type { TTSLocation, TTSSentenceAlignment } from '@/types/tts';
import type { ReaderType } from '@/types/user-state';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';

export type SetTtsTextOptions = {
  shouldPause?: boolean;
  location?: TTSLocation;
  startLocator?: TTSSegmentLocator;
};

type UseTtsDocumentNavigationInput = {
  activeReaderType: ReaderType;
  currDocPage: TTSLocation;
  currDocPageNumber: number;
  currentIndex: number;
  isEPUB: boolean;
  isPlaying: boolean;
  sentences: string[];
  skipBlank: boolean;
  advanceRef: MutableRefObject<((backwards?: boolean) => void | Promise<void>) | null>;
  epubJumpEpochRef: MutableRefObject<number>;
  isPlayingRef: MutableRefObject<boolean>;
  locationChangeHandlerRef: MutableRefObject<((location: TTSLocation | TTSSegmentLocator) => void) | null>;
  pauseEpochRef: MutableRefObject<number>;
  pendingEpubJumpRef: MutableRefObject<{ epoch: number; locator?: TTSSegmentLocator | null } | null>;
  playbackActiveRef: MutableRefObject<boolean>;
  playbackAnchorRef: MutableRefObject<PlaybackAnchor | null>;
  playbackSegmentsRef: MutableRefObject<CanonicalTtsSegment[]>;
  playbackSyncNavigationRef: MutableRefObject<boolean>;
  resumeAfterLocationChangeRef: MutableRefObject<boolean>;
  sentenceAlignmentCacheRef: MutableRefObject<Map<string, TTSSentenceAlignment>>;
  abortAudio: () => void;
  cancelSeekResync: () => void;
  clearPendingEpubJump: () => void;
  clearPlaybackSegments: (options?: { resetSelection?: boolean }) => void;
  invalidatePlaybackRun: () => void;
  pauseActivePlayback: () => void;
  resetPlaybackPlan: (options?: { resetSelection?: boolean; resetSeekLayout?: boolean }) => void;
  seekPlaybackToOrdinal: (ordinal: number) => boolean;
  selectPlaybackSegment: (segment: CanonicalTtsSegment | null | undefined) => boolean;
  setCurrentSentenceAlignment: (alignment: TTSSentenceAlignment | undefined) => void;
  setCurrentWordIndex: (wordIndex: number | null) => void;
  setCurrDocPage: (location: TTSLocation) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setIsProcessing: (isProcessing: boolean) => void;
  setPlaybackAnchor: (anchor: PlaybackAnchor | null) => void;
};

export function useTtsDocumentNavigation(input: UseTtsDocumentNavigationInput) {
  const {
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
  } = input;

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying, isPlayingRef]);

  const pause = useCallback(() => {
    resumeAfterLocationChangeRef.current = false;
    pauseEpochRef.current += 1;
    clearPendingEpubJump();
    cancelSeekResync();
    pauseActivePlayback();
    setIsPlaying(false);
  }, [
    cancelSeekResync,
    clearPendingEpubJump,
    pauseActivePlayback,
    pauseEpochRef,
    resumeAfterLocationChangeRef,
    setIsPlaying,
  ]);

  const skipToLocation = useCallback((location: TTSLocation, shouldPause = false) => {
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
      if (planIndex >= 0) selectPlaybackSegment(playbackSegmentsRef.current[planIndex]);
      return;
    }

    if (shouldPause) {
      resumeAfterLocationChangeRef.current = false;
    } else if (isPlayingRef.current) {
      resumeAfterLocationChangeRef.current = true;
    }
    invalidatePlaybackRun();
    abortAudio();
    if (shouldPause) setIsPlaying(false);
    clearPlaybackSegments();
    playbackAnchorRef.current = null;
    setPlaybackAnchor(null);
    setCurrDocPage(location);
  }, [
    abortAudio,
    activeReaderType,
    clearPlaybackSegments,
    invalidatePlaybackRun,
    isPlayingRef,
    pauseActivePlayback,
    playbackAnchorRef,
    playbackSegmentsRef,
    playbackSyncNavigationRef,
    resumeAfterLocationChangeRef,
    selectPlaybackSegment,
    setCurrDocPage,
    setIsPlaying,
    setPlaybackAnchor,
  ]);

  const prepareInitialPosition = useCallback((location: TTSLocation) => {
    skipToLocation(location, true);
  }, [skipToLocation]);

  const advance = useCallback(async (backwards = false) => {
    const nextIndex = currentIndex + (backwards ? -1 : 1);
    if (nextIndex < sentences.length && nextIndex >= 0) {
      selectPlaybackSegment(playbackSegmentsRef.current[nextIndex]);
      return;
    }

    if (isEPUB && locationChangeHandlerRef.current) {
      const direction = nextIndex >= sentences.length ? 'next' : 'prev';
      if (isPlayingRef.current) resumeAfterLocationChangeRef.current = true;
      invalidatePlaybackRun();
      clearPlaybackSegments();
      playbackAnchorRef.current = null;
      setPlaybackAnchor(null);
      setCurrentSentenceAlignment(undefined);
      setCurrentWordIndex(null);
      locationChangeHandlerRef.current(direction);
      return;
    }

    setIsPlaying(false);
  }, [
    clearPlaybackSegments,
    currentIndex,
    invalidatePlaybackRun,
    isEPUB,
    isPlayingRef,
    locationChangeHandlerRef,
    playbackAnchorRef,
    playbackSegmentsRef,
    resumeAfterLocationChangeRef,
    selectPlaybackSegment,
    sentences,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    setIsPlaying,
    setPlaybackAnchor,
  ]);
  advanceRef.current = advance;

  const handleBlankSection = useCallback((text: string): boolean => {
    if (!isPlaying || !skipBlank || text.length > 0) return false;
    void advance();
    toast.success(isEPUB ? 'Skipping blank section' : `Skipping blank page ${currDocPageNumber}`, {
      id: isEPUB ? 'epub-section-skip' : `page-${currDocPageNumber}`,
      style: { background: 'var(--background)', color: 'var(--accent)' },
      duration: 1000,
      position: 'top-center',
    });
    return true;
  }, [advance, currDocPageNumber, isEPUB, isPlaying, skipBlank]);

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

    const planIndex = resolveFirstPlanIndexForDocumentAnchor(
      playbackSegmentsRef.current,
      activeReaderType,
      resolvedLocation,
    );
    if (planIndex >= 0) {
      selectPlaybackSegment(playbackSegmentsRef.current[planIndex]);
    } else if (!playbackActiveRef.current) {
      resetPlaybackPlan();
      sentenceAlignmentCacheRef.current.clear();
      setCurrentSentenceAlignment(undefined);
      setCurrentWordIndex(null);
    }
    setIsProcessing(false);
  }, [
    activeReaderType,
    playbackActiveRef,
    playbackAnchorRef,
    playbackSegmentsRef,
    playbackSyncNavigationRef,
    resetPlaybackPlan,
    selectPlaybackSegment,
    sentenceAlignmentCacheRef,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    setCurrDocPage,
    setIsProcessing,
    setPlaybackAnchor,
  ]);

  const setDocumentPlaybackAnchor = useCallback((
    location: TTSLocation,
    hasReadableText: boolean,
    locator?: TTSSegmentLocator | null,
  ) => applyDocumentPlaybackAnchor(location, hasReadableText, locator), [applyDocumentPlaybackAnchor]);

  const setText = useCallback((text: string, options?: boolean | SetTtsTextOptions) => {
    const normalizedOptions: SetTtsTextOptions = typeof options === 'boolean'
      ? { shouldPause: options }
      : (options || {});
    const resolvedLocation = normalizedOptions.location ?? currDocPage;
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
    if (pendingEpubLocator) clearPendingEpubJump();

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
    invalidatePlaybackRun();
    setIsPlaying(false);
    abortAudio();
    setIsProcessing(true);

    try {
      if (!text.trim()) {
        if (shouldPause || pendingAutoResume) resumeAfterLocationChangeRef.current = false;
        setIsProcessing(false);
        return;
      }
      if (shouldPause || pendingAutoResume) resumeAfterLocationChangeRef.current = false;
      clearPlaybackSegments();
      if (!pendingEpubLocator && isEPUB) clearPendingEpubJump();
      sentenceAlignmentCacheRef.current.clear();
      setCurrentSentenceAlignment(undefined);
      setCurrentWordIndex(null);
      setIsProcessing(false);
      if (shouldResumePlayback && pauseEpochRef.current === pauseEpochAtStart) setIsPlaying(true);
    } catch (error) {
      console.warn('Error processing text:', error);
      setIsProcessing(false);
      toast.error('Failed to process text', { duration: 3000 });
    }
  }, [
    abortAudio,
    activeReaderType,
    applyDocumentPlaybackAnchor,
    clearPendingEpubJump,
    clearPlaybackSegments,
    currDocPage,
    currDocPageNumber,
    epubJumpEpochRef,
    handleBlankSection,
    invalidatePlaybackRun,
    isEPUB,
    isPlaying,
    pauseEpochRef,
    pendingEpubJumpRef,
    playbackAnchorRef,
    playbackSyncNavigationRef,
    resumeAfterLocationChangeRef,
    sentenceAlignmentCacheRef,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    setCurrDocPage,
    setIsPlaying,
    setIsProcessing,
    setPlaybackAnchor,
  ]);

  const skipForward = useCallback(async () => {
    const nextSegment = playbackSegmentsRef.current[currentIndex + 1];
    if (nextSegment && seekPlaybackToOrdinal(nextSegment.ordinal)) return;
    if (isPlaying) setIsProcessing(true);
    invalidatePlaybackRun();
    abortAudio();
    await advance();
  }, [abortAudio, advance, currentIndex, invalidatePlaybackRun, isPlaying, playbackSegmentsRef, seekPlaybackToOrdinal, setIsProcessing]);

  const skipBackward = useCallback(async () => {
    const nextIndex = currentIndex - 1;
    const nextSegment = playbackSegmentsRef.current[nextIndex];
    if (nextIndex >= 0 && nextSegment && seekPlaybackToOrdinal(nextSegment.ordinal)) return;
    if (isPlaying) setIsProcessing(true);
    invalidatePlaybackRun();
    abortAudio();
    await advance(true);
  }, [abortAudio, advance, currentIndex, invalidatePlaybackRun, isPlaying, playbackSegmentsRef, seekPlaybackToOrdinal, setIsProcessing]);

  return {
    pause,
    prepareInitialPosition,
    setDocumentPlaybackAnchor,
    setText,
    skipBackward,
    skipForward,
    skipToLocation,
  };
}

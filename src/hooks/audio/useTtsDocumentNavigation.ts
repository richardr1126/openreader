'use client';

import { useCallback, useEffect, type MutableRefObject } from 'react';

import {
  pdfAnchorPage,
  resolveDocumentAnchorSelectionOrdinal,
  resolveEpubPlanBackedSelection,
  resolveFirstPlanIndexForDocumentAnchor,
  type PlaybackAnchor,
} from '@/lib/client/tts/playback-selection';
import type { TtsPlaybackPlan } from '@/lib/shared/playback-plan';
import type { TTSSegmentLocator } from '@/types/client';
import type { TTSLocation } from '@/types/tts';
import type { ReaderType } from '@/types/user-state';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';
import { isStableEpubLocator } from '@openreader/tts/types';

export type EpubRenderedAnchorInput = {
  locator: TTSSegmentLocator | null;
  hasReadableText: boolean;
  shouldPause?: boolean;
  preservePlaybackCursor?: boolean;
};

export type EpubRenderedAnchorResult =
  | { status: 'waiting-plan' }
  | { status: 'empty-plan' }
  | { status: 'non-text' }
  | { status: 'invalid-anchor' }
  | { status: 'unmapped-anchor' }
  | { status: 'selected'; ordinal: number };

export type EpubPlanLocatorResult =
  | { status: 'waiting-plan' }
  | { status: 'empty-plan' }
  | { status: 'invalid-locator' }
  | { status: 'unmapped-locator' }
  | { status: 'selected'; ordinal: number; displayLocator: TTSSegmentLocator };

type UseTtsDocumentNavigationInput = {
  activeReaderType: ReaderType;
  currentIndex: number;
  isPlaying: boolean;
  sentences: string[];
  advanceRef: MutableRefObject<((backwards?: boolean) => void | Promise<void>) | null>;
  isPlayingRef: MutableRefObject<boolean>;
  pauseEpochRef: MutableRefObject<number>;
  playbackAnchorRef: MutableRefObject<PlaybackAnchor | null>;
  playbackPlanReady: boolean;
  playbackPlanRef: MutableRefObject<TtsPlaybackPlan | null>;
  playbackSegmentsRef: MutableRefObject<CanonicalTtsSegment[]>;
  selectedOrdinalRef: MutableRefObject<number | null>;
  playbackSyncNavigationRef: MutableRefObject<boolean>;
  resumeAfterLocationChangeRef: MutableRefObject<boolean>;
  abortAudio: () => void;
  cancelSeekResync: () => void;
  invalidatePlaybackRun: () => void;
  pauseActivePlayback: () => void;
  seekPlaybackToOrdinal: (ordinal: number) => boolean;
  syncActivePlaybackToOrdinal: (ordinal: number) => boolean;
  selectPlaybackSegment: (segment: CanonicalTtsSegment | null | undefined) => boolean;
  setCurrDocPage: (location: TTSLocation) => void;
  setIsPlaying: (isPlaying: boolean) => void;
  setIsProcessing: (isProcessing: boolean) => void;
  setPlaybackAnchor: (anchor: PlaybackAnchor | null) => void;
  setSelectedOrdinal: (ordinal: number | null) => void;
};

export function useTtsDocumentNavigation(input: UseTtsDocumentNavigationInput) {
  const {
    activeReaderType,
    currentIndex,
    isPlaying,
    sentences,
    advanceRef,
    isPlayingRef,
    pauseEpochRef,
    playbackAnchorRef,
    playbackPlanReady,
    playbackPlanRef,
    playbackSegmentsRef,
    selectedOrdinalRef,
    playbackSyncNavigationRef,
    resumeAfterLocationChangeRef,
    abortAudio,
    cancelSeekResync,
    invalidatePlaybackRun,
    pauseActivePlayback,
    seekPlaybackToOrdinal,
    syncActivePlaybackToOrdinal,
    selectPlaybackSegment,
    setCurrDocPage,
    setIsPlaying,
    setIsProcessing,
    setPlaybackAnchor,
    setSelectedOrdinal,
  } = input;

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying, isPlayingRef]);

  const pause = useCallback(() => {
    resumeAfterLocationChangeRef.current = false;
    pauseEpochRef.current += 1;
    cancelSeekResync();
    pauseActivePlayback();
    setIsPlaying(false);
  }, [
    cancelSeekResync,
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

    setCurrDocPage(location);
    if (shouldPause) {
      resumeAfterLocationChangeRef.current = false;
      pauseActivePlayback();
      setIsPlaying(false);
    } else if (isPlayingRef.current) {
      resumeAfterLocationChangeRef.current = true;
    }

    if (activeReaderType === 'pdf' || activeReaderType === 'html') {
      const planIndex = resolveFirstPlanIndexForDocumentAnchor(
        playbackSegmentsRef.current,
        activeReaderType,
        location,
      );
      if (planIndex >= 0) selectPlaybackSegment(playbackSegmentsRef.current[planIndex]);
    }
  }, [
    activeReaderType,
    isPlayingRef,
    pauseActivePlayback,
    playbackSegmentsRef,
    playbackSyncNavigationRef,
    resumeAfterLocationChangeRef,
    selectPlaybackSegment,
    setCurrDocPage,
    setIsPlaying,
  ]);

  const advance = useCallback(async (backwards = false) => {
    const nextIndex = currentIndex + (backwards ? -1 : 1);
    if (nextIndex < sentences.length && nextIndex >= 0) {
      selectPlaybackSegment(playbackSegmentsRef.current[nextIndex]);
      return;
    }
    setIsPlaying(false);
  }, [
    currentIndex,
    playbackSegmentsRef,
    selectPlaybackSegment,
    sentences.length,
    setIsPlaying,
  ]);
  advanceRef.current = advance;

  const setDocumentPlaybackAnchor = useCallback((
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

    const selectedOrdinal = activeReaderType === 'pdf' || activeReaderType === 'html'
      ? resolveDocumentAnchorSelectionOrdinal({
        plan: playbackSegmentsRef.current,
        readerType: activeReaderType,
        location: resolvedLocation,
        selectedOrdinal: selectedOrdinalRef.current,
      })
      : null;
    if (selectedOrdinal !== null) {
      setSelectedOrdinal(selectedOrdinal);
    } else if (playbackPlanRef.current) {
      setSelectedOrdinal(null);
    }
    setIsProcessing(false);
  }, [
    activeReaderType,
    playbackAnchorRef,
    playbackPlanRef,
    playbackSegmentsRef,
    playbackSyncNavigationRef,
    selectedOrdinalRef,
    setCurrDocPage,
    setIsProcessing,
    setPlaybackAnchor,
    setSelectedOrdinal,
  ]);

  const reconcileEpubRenderedAnchor = useCallback((
    rendered: EpubRenderedAnchorInput,
  ): EpubRenderedAnchorResult => {
    const renderedLocation: TTSLocation = isStableEpubLocator(rendered.locator)
      ? `epub:${rendered.locator.spineIndex}:${encodeURIComponent(rendered.locator.spineHref)}:${rendered.locator.charOffset}`
      : 1;
    const nextAnchor: PlaybackAnchor = {
      text: '',
      location: renderedLocation,
      locator: rendered.locator,
      hasContent: rendered.hasReadableText,
    };
    playbackAnchorRef.current = nextAnchor;
    setPlaybackAnchor(nextAnchor);
    setCurrDocPage(renderedLocation);

    if (!playbackPlanReady || !playbackPlanRef.current) return { status: 'waiting-plan' };

    if (!rendered.hasReadableText) {
      playbackSyncNavigationRef.current = false;
      if (rendered.preservePlaybackCursor) {
        setIsProcessing(false);
        return { status: 'non-text' };
      }
      resumeAfterLocationChangeRef.current = false;
      pauseActivePlayback();
      setIsPlaying(false);
      setSelectedOrdinal(null);
      setIsProcessing(false);
      return { status: 'non-text' };
    }

    const resolution = resolveEpubPlanBackedSelection({
      plan: playbackSegmentsRef.current,
      locator: rendered.locator,
    });
    const playbackDrivenNavigation = playbackSyncNavigationRef.current;
    playbackSyncNavigationRef.current = false;
    const preservePlaybackCursor = rendered.preservePlaybackCursor === true
      || playbackDrivenNavigation;
    if (resolution.status === 'invalid-anchor' || resolution.status === 'unmapped-anchor') {
      return resolution;
    }

    if (rendered.shouldPause && !preservePlaybackCursor) {
      resumeAfterLocationChangeRef.current = false;
      pauseActivePlayback();
      setIsPlaying(false);
    }

    if (resolution.status === 'empty-plan') {
      if (!preservePlaybackCursor) setSelectedOrdinal(null);
      setIsProcessing(false);
      return resolution;
    }

    if (!preservePlaybackCursor) {
      setSelectedOrdinal(resolution.ordinal);
      if (!rendered.shouldPause) syncActivePlaybackToOrdinal(resolution.ordinal);
    }
    resumeAfterLocationChangeRef.current = false;
    setIsProcessing(false);
    return { status: 'selected', ordinal: resolution.ordinal };
  }, [
    pauseActivePlayback,
    playbackAnchorRef,
    playbackPlanReady,
    playbackPlanRef,
    playbackSegmentsRef,
    playbackSyncNavigationRef,
    resumeAfterLocationChangeRef,
    syncActivePlaybackToOrdinal,
    setCurrDocPage,
    setIsPlaying,
    setIsProcessing,
    setPlaybackAnchor,
    setSelectedOrdinal,
  ]);

  const resolveEpubPlanLocator = useCallback((
    savedLocator: TTSSegmentLocator | null,
  ): EpubPlanLocatorResult => {
    if (!playbackPlanReady || !playbackPlanRef.current) return { status: 'waiting-plan' };
    const plan = playbackSegmentsRef.current;
    if (plan.length === 0) {
      return { status: 'empty-plan' };
    }

    if (!savedLocator) {
      const first = plan[0];
      if (!first || !isStableEpubLocator(first.ownerLocator)) return { status: 'invalid-locator' };
      return {
        status: 'selected',
        ordinal: first.ordinal,
        displayLocator: first.ownerLocator,
      };
    }

    const resolution = resolveEpubPlanBackedSelection({ plan, locator: savedLocator });
    if (resolution.status === 'invalid-anchor') return { status: 'invalid-locator' };
    if (resolution.status === 'unmapped-anchor') return { status: 'unmapped-locator' };
    if (resolution.status === 'empty-plan') return { status: 'empty-plan' };
    return {
      status: 'selected',
      ordinal: resolution.ordinal,
      displayLocator: savedLocator,
    };
  }, [
    playbackPlanReady,
    playbackPlanRef,
    playbackSegmentsRef,
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
    reconcileEpubRenderedAnchor,
    resolveEpubPlanLocator,
    setDocumentPlaybackAnchor,
    skipBackward,
    skipForward,
    skipToLocation,
  };
}

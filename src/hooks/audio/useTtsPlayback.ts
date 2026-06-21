'use client';

import { useCallback, useRef, type MutableRefObject } from 'react';
import {
  normalizePlaybackTimeline,
  projectTimelineAtTime,
  type TtsPlaybackTimeline,
} from '@/lib/client/tts/playback-timeline';
import type { TTSLocation, TTSSentenceAlignment } from '@/types/tts';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';

type UseTtsPlaybackInput = {
  playbackSegmentsRef: MutableRefObject<CanonicalTtsSegment[]>;
  currentIndexRef: MutableRefObject<number>;
  setCurrDocPage: (location: TTSLocation) => void;
  setCurrentIndex: (index: number) => void;
  setCurrentSentenceAlignment: (alignment: TTSSentenceAlignment | undefined) => void;
  setCurrentWordIndex: (wordIndex: number | null) => void;
};

export function useTtsPlayback(input: UseTtsPlaybackInput) {
  const {
    playbackSegmentsRef,
    currentIndexRef,
    setCurrDocPage,
    setCurrentIndex,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
  } = input;
  const playbackTimelineRef = useRef<TtsPlaybackTimeline | null>(null);
  const playbackSessionRef = useRef<{ sessionId: string; audioUrl: string; timelineUrl: string } | null>(null);
  const playbackTimelinePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playbackEventsUnsubRef = useRef<(() => void) | null>(null);
  const playbackCursorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playbackActiveRef = useRef(false);

  const stopPlaybackTimelinePolling = useCallback(() => {
    if (playbackTimelinePollRef.current) {
      clearInterval(playbackTimelinePollRef.current);
      playbackTimelinePollRef.current = null;
    }
    if (playbackCursorIntervalRef.current) {
      clearInterval(playbackCursorIntervalRef.current);
      playbackCursorIntervalRef.current = null;
    }
    if (playbackEventsUnsubRef.current) {
      try {
        playbackEventsUnsubRef.current();
      } catch {
        // ignore teardown errors
      }
      playbackEventsUnsubRef.current = null;
    }
  }, []);

  const projectPlaybackTime = useCallback((currentTimeSec: number) => {
    const timeline = playbackTimelineRef.current;
    if (!timeline) return;
    const projection = projectTimelineAtTime(timeline, currentTimeSec);
    if (!projection.segment) return;

    const segments = playbackSegmentsRef.current;
    const segmentKey = projection.segment.segmentKey;
    let nextIndex = segmentKey
      ? segments.findIndex((segment) => segment.key === segmentKey)
      : -1;
    if (nextIndex < 0) {
      nextIndex = projection.segment.sourceSegmentIndex ?? projection.segment.ordinal;
    }
    if (nextIndex >= 0 && currentIndexRef.current !== nextIndex) {
      setCurrentIndex(nextIndex);
    }
    setCurrentSentenceAlignment(projection.segment.alignment ?? undefined);
    setCurrentWordIndex(projection.wordIndex);

    const locator = projection.segment.locator;
    if (locator?.readerType === 'pdf' && typeof locator.page === 'number') {
      setCurrDocPage(Math.max(1, Math.floor(locator.page)));
    }
  }, [
    currentIndexRef,
    playbackSegmentsRef,
    setCurrDocPage,
    setCurrentIndex,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
  ]);

  const refreshPlaybackTimeline = useCallback(async (timelineUrl: string, signal?: AbortSignal) => {
    const response = await fetch(timelineUrl, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to load TTS playback timeline: ${response.status}`);
    }
    const timeline = normalizePlaybackTimeline(await response.json());
    playbackTimelineRef.current = timeline;
    return timeline;
  }, []);

  const resetPlaybackRefs = useCallback(() => {
    stopPlaybackTimelinePolling();
    playbackActiveRef.current = false;
    playbackSessionRef.current = null;
    playbackTimelineRef.current = null;
  }, [stopPlaybackTimelinePolling]);

  return {
    playbackActiveRef,
    playbackCursorIntervalRef,
    playbackEventsUnsubRef,
    playbackSessionRef,
    playbackTimelinePollRef,
    projectPlaybackTime,
    refreshPlaybackTimeline,
    resetPlaybackRefs,
    stopPlaybackTimelinePolling,
  };
}

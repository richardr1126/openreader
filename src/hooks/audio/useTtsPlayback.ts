'use client';

import { useCallback, useRef, type MutableRefObject } from 'react';
import {
  normalizePlaybackTimeline,
  projectTimelineAtTime,
  type TtsPlaybackTimeline,
} from '@/lib/client/tts/playback-timeline';
import type { TTSLocation, TTSSentenceAlignment } from '@/types/tts';
import { isPdfLocator } from '@/types/client';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';

type UseTtsPlaybackInput = {
  playbackSegmentsRef: MutableRefObject<CanonicalTtsSegment[]>;
  currentIndexRef: MutableRefObject<number>;
  setCurrDocPage: (location: TTSLocation) => void;
  syncPlaybackLocator?: (locator: import('@/types/client').TTSSegmentLocator | null) => void;
  setPlaybackIndex: (index: number) => void;
  setCurrentSentenceAlignment: (alignment: TTSSentenceAlignment | undefined) => void;
  setCurrentWordIndex: (wordIndex: number | null) => void;
};

const WORD_HIGHLIGHT_LEAD_SEC = 0.12;

export function useTtsPlayback(input: UseTtsPlaybackInput) {
  const {
    playbackSegmentsRef,
    currentIndexRef,
    setCurrDocPage,
    syncPlaybackLocator,
    setPlaybackIndex,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
  } = input;
  const playbackTimelineRef = useRef<TtsPlaybackTimeline | null>(null);
  const playbackSessionRef = useRef<{
    sessionId: string;
    audioUrl: string;
    timelineUrl: string;
    seekLayoutUrl?: string;
  } | null>(null);
  const playbackEventsUnsubRef = useRef<(() => void) | null>(null);
  const playbackCursorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playbackActiveRef = useRef(false);
  const lastProjectionRef = useRef<{
    segmentId: string;
    index: number;
    wordIndex: number | null;
    alignment: TTSSentenceAlignment | null | undefined;
    locatorKey: string;
  } | null>(null);

  const stopPlaybackTimelinePolling = useCallback(() => {
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
    const projection = projectTimelineAtTime(timeline, currentTimeSec, { wordLeadSec: WORD_HIGHLIGHT_LEAD_SEC });
    if (!projection.segment) return;

    const segments = playbackSegmentsRef.current;
    const segmentKey = projection.segment.segmentKey;
    let nextIndex = segmentKey
      ? segments.findIndex((segment) => segment.key === segmentKey)
      : -1;
    if (nextIndex < 0) {
      nextIndex = segments.findIndex((segment) => segment.ordinal === projection.segment?.ordinal);
    }
    if (nextIndex < 0) return;
    const locator = projection.segment.locator;
    const page = isPdfLocator(locator) ? Math.max(1, Math.floor(locator.page)) : null;
    const locatorKey = locator
      ? JSON.stringify({
        readerType: locator.readerType,
        page: locator.page ?? null,
        spineIndex: locator.spineIndex ?? null,
        spineHref: locator.spineHref ?? null,
        charOffset: locator.charOffset ?? null,
        location: locator.location ?? null,
      })
      : '';
    const previous = lastProjectionRef.current;
    const segmentId = projection.segment.segmentId;
    const alignment = projection.segment.alignment ?? undefined;
    if (
      previous
      && previous.segmentId === segmentId
      && previous.index === nextIndex
      && previous.wordIndex === projection.wordIndex
      && previous.alignment === alignment
      && previous.locatorKey === locatorKey
    ) {
      return;
    }
    lastProjectionRef.current = {
      segmentId,
      index: nextIndex,
      wordIndex: projection.wordIndex,
      alignment,
      locatorKey,
    };

    if (nextIndex >= 0 && currentIndexRef.current !== nextIndex) {
      setPlaybackIndex(nextIndex);
    }
    setCurrentSentenceAlignment(alignment);
    setCurrentWordIndex(projection.wordIndex);

    if (page !== null) {
      setCurrDocPage(page);
    }
    if (locator) {
      syncPlaybackLocator?.(locator);
    }
  }, [
    currentIndexRef,
    playbackSegmentsRef,
    setCurrDocPage,
    syncPlaybackLocator,
    setPlaybackIndex,
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
    lastProjectionRef.current = null;
  }, [stopPlaybackTimelinePolling]);

  return {
    playbackActiveRef,
    playbackCursorIntervalRef,
    playbackEventsUnsubRef,
    playbackSessionRef,
    projectPlaybackTime,
    refreshPlaybackTimeline,
    resetPlaybackRefs,
    stopPlaybackTimelinePolling,
  };
}

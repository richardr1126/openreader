'use client';

import { useCallback, useRef, type MutableRefObject } from 'react';
import {
  normalizePlaybackGrid,
  projectPlaybackGridAtTime,
  type TtsPlaybackGrid,
} from '@/lib/client/tts/playback-grid';
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

function locatorProjectionKey(locator: import('@/types/client').TTSSegmentLocator | null): string {
  if (!locator) return '';
  return [
    locator.readerType,
    locator.page ?? '',
    locator.spineIndex ?? '',
    locator.spineHref ?? '',
    locator.charOffset ?? '',
    locator.location ?? '',
  ].join('|');
}

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
  const playbackTimelineRef = useRef<TtsPlaybackGrid | null>(null);
  const playbackSessionRef = useRef<{
    sessionId: string;
    audioUrl: string;
    timelineUrl: string;
    seekLayoutUrl?: string;
  } | null>(null);
  const playbackEventsUnsubRef = useRef<(() => void) | null>(null);
  const playbackCursorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playbackActiveRef = useRef(false);
  const ordinalIndexCacheRef = useRef<{
    source: CanonicalTtsSegment[];
    byOrdinal: Map<number, number>;
  } | null>(null);
  const lastProjectionRef = useRef<{
    segmentId: string;
    index: number;
    wordIndex: number | null;
    alignment: TTSSentenceAlignment | null | undefined;
    locatorKey: string;
  } | null>(null);
  // Throttle for the stale-grid self-heal refresh (see projectPlaybackTime).
  const lastTimelineHealAtRef = useRef(0);
  // The single playback cursor: the plan ordinal under the playhead. Written
  // ONLY by the playhead projection (and seeded once at start/seek), so the
  // heartbeat reports exactly the highlighted segment and never a transient
  // `setPlaybackIndex(0)` reset bleeding through `currentIndexRef`. `null`
  // means "no faithful position yet" — don't post.
  const playbackCursorOrdinalRef = useRef<number | null>(null);

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

  const refreshPlaybackTimeline = useCallback(async (timelineUrl: string, signal?: AbortSignal) => {
    const response = await fetch(timelineUrl, {
      cache: 'no-store',
      signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to load TTS playback timeline: ${response.status}`);
    }
    const timeline = normalizePlaybackGrid(await response.json());
    playbackTimelineRef.current = timeline;
    return timeline;
  }, []);

  const projectPlaybackTime = useCallback((currentTimeSec: number) => {
    const timeline = playbackTimelineRef.current;
    if (!timeline) return;
    const projection = projectPlaybackGridAtTime(timeline, currentTimeSec, { wordLeadSec: WORD_HIGHLIGHT_LEAD_SEC });
    if (!projection.segment) return;

    // Self-heal a stale grid. The grid carries real durations + word alignment
    // only for GENERATED slots; ungenerated slots are estimates with null
    // alignment (so the word highlight vanishes) and estimate-based timing (so
    // the sentence/scrubber drift). After a forward seek the playhead lands on
    // such estimated slots until the grid is refreshed with the now-generated
    // region. The SSE refresh doesn't always cover a post-seek continuation, so
    // when we're actively playing over an ungenerated slot, pull a fresh grid
    // (throttled). As the seeked region finishes generating, the refreshed grid
    // turns those slots exact and the highlight returns — no pause/play needed.
    if (projection.segment.generated === false) {
      const session = playbackSessionRef.current;
      const now = Date.now();
      if (session?.timelineUrl && now - lastTimelineHealAtRef.current > 1_000) {
        lastTimelineHealAtRef.current = now;
        void refreshPlaybackTimeline(session.timelineUrl).catch(() => undefined);
      }
    }

    const segments = playbackSegmentsRef.current;
    let ordinalIndexCache = ordinalIndexCacheRef.current;
    if (!ordinalIndexCache || ordinalIndexCache.source !== segments) {
      ordinalIndexCache = {
        source: segments,
        byOrdinal: new Map(segments.map((segment, index) => [segment.ordinal, index])),
      };
      ordinalIndexCacheRef.current = ordinalIndexCache;
    }
    // `ordinal` is the authoritative, unique plan index. `segmentKey` is a hash
    // of the segment text and is NOT unique (repeated lines, chapter labels,
    // dividers, refrains), so playback projection must not use it.
    const targetOrdinal = projection.segment.ordinal;
    const nextIndex = ordinalIndexCache.byOrdinal.get(targetOrdinal) ?? -1;
    if (nextIndex < 0) return;
    // The playhead's ordinal IS the cursor. Set it before the dedupe early-return
    // below so the heartbeat always sees the live playhead, even on a tick where
    // the highlight didn't change.
    playbackCursorOrdinalRef.current = targetOrdinal;
    const locator = projection.segment.locator;
    const page = isPdfLocator(locator) ? Math.max(1, Math.floor(locator.page)) : null;
    const locatorKey = locatorProjectionKey(locator);
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
    refreshPlaybackTimeline,
    setCurrDocPage,
    syncPlaybackLocator,
    setPlaybackIndex,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
  ]);

  const resetPlaybackRefs = useCallback(() => {
    stopPlaybackTimelinePolling();
    playbackActiveRef.current = false;
    playbackSessionRef.current = null;
    playbackTimelineRef.current = null;
    ordinalIndexCacheRef.current = null;
    lastProjectionRef.current = null;
    playbackCursorOrdinalRef.current = null;
  }, [stopPlaybackTimelinePolling]);

  return {
    playbackActiveRef,
    playbackCursorIntervalRef,
    playbackCursorOrdinalRef,
    playbackEventsUnsubRef,
    playbackSessionRef,
    projectPlaybackTime,
    refreshPlaybackTimeline,
    resetPlaybackRefs,
    stopPlaybackTimelinePolling,
  };
}

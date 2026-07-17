'use client';

import { useCallback, useRef, useState, type MutableRefObject } from 'react';

import {
  documentTimeToMediaTime,
  mediaTimeToDocumentTime,
  normalizePlaybackGrid,
  projectPlaybackGridAtTime,
  type TtsPlaybackGrid,
} from '@/lib/client/tts/playback-grid';
import { isPdfLocator, type TTSSegmentLocator } from '@/types/client';
import type { TTSLocation, TTSSentenceAlignment } from '@/types/tts';

export type PlaybackSessionState = {
  sessionId: string;
  audioUrl: string;
  timelineUrl: string;
  seekLayoutUrl?: string;
};

const WORD_HIGHLIGHT_LEAD_SEC = 0.12;

function locatorProjectionKey(locator: TTSSegmentLocator | null): string {
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

type UsePlaybackProjectionInput = {
  playbackRunIdRef: MutableRefObject<number>;
  playbackSessionRef: MutableRefObject<PlaybackSessionState | null>;
  selectedOrdinalRef: MutableRefObject<number | null>;
  setCurrDocPage: (location: TTSLocation) => void;
  setCurrentSentenceAlignment: (alignment: TTSSentenceAlignment | undefined) => void;
  setCurrentWordIndex: (wordIndex: number | null) => void;
  setSelectedOrdinal: (ordinal: number | null) => void;
  syncPlaybackLocator?: (locator: TTSSegmentLocator | null) => void;
};

export function usePlaybackProjection(input: UsePlaybackProjectionInput) {
  const {
    playbackRunIdRef,
    playbackSessionRef,
    selectedOrdinalRef,
    setCurrDocPage,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    setSelectedOrdinal,
    syncPlaybackLocator,
  } = input;
  const playbackProjectionRafRef = useRef<number | null>(null);
  const playbackStreamBaseSecRef = useRef(0);
  const playbackTimelineRef = useRef<TtsPlaybackGrid | null>(null);
  const playbackCursorOrdinalRef = useRef<number | null>(null);
  const [playbackTimeSec, setPlaybackTimeSec] = useState(0);
  const playbackTimeSecRef = useRef(0);
  const lastPlaybackTimePublishedAtRef = useRef(0);
  const lastProjectionRef = useRef<{
    ordinal: number;
    wordIndex: number | null;
    alignment: TTSSentenceAlignment | null | undefined;
    locatorKey: string;
  } | null>(null);
  const lastTimelineHealAtRef = useRef(0);

  const publishPlaybackTimeSec = useCallback((value: number, options?: { force?: boolean }) => {
    const next = Math.max(0, Number.isFinite(value) ? value : 0);
    playbackTimeSecRef.current = next;
    const now = Date.now();
    if (!options?.force && now - lastPlaybackTimePublishedAtRef.current < 250) return;
    lastPlaybackTimePublishedAtRef.current = now;
    setPlaybackTimeSec(next);
  }, []);

  const documentTimeForAudio = useCallback((audio: HTMLAudioElement): number => (
    mediaTimeToDocumentTime(audio.currentTime, playbackStreamBaseSecRef.current)
  ), []);

  const setAudioDocumentTime = useCallback((
    audio: HTMLAudioElement,
    documentTimeSec: number,
    targetOrdinal: number,
    targetStartSec: number,
  ) => {
    const target = Math.max(0, documentTimeSec);
    let base = playbackStreamBaseSecRef.current;
    if (target + 0.001 < base) {
      const session = playbackSessionRef.current;
      if (session) {
        const url = new URL(session.audioUrl, window.location.href);
        url.searchParams.set('fromOrdinal', String(Math.max(0, Math.floor(targetOrdinal))));
        base = Math.max(0, targetStartSec);
        playbackStreamBaseSecRef.current = base;
        audio.src = url.toString();
        audio.load();
      }
    }
    audio.currentTime = documentTimeToMediaTime(target, base);
  }, [playbackSessionRef]);

  const refreshPlaybackTimeline = useCallback(async (timelineUrl: string, signal?: AbortSignal) => {
    const response = await fetch(timelineUrl, { cache: 'no-store', signal });
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
    const projection = projectPlaybackGridAtTime(timeline, currentTimeSec, {
      wordLeadSec: WORD_HIGHLIGHT_LEAD_SEC,
    });
    if (!projection.segment) return;

    if (projection.segment.generated === false) {
      const session = playbackSessionRef.current;
      const now = Date.now();
      if (session?.timelineUrl && now - lastTimelineHealAtRef.current > 1_000) {
        lastTimelineHealAtRef.current = now;
        void refreshPlaybackTimeline(session.timelineUrl).catch(() => undefined);
      }
    }

    const targetOrdinal = projection.segment.ordinal;
    playbackCursorOrdinalRef.current = targetOrdinal;
    if (selectedOrdinalRef.current !== targetOrdinal) {
      setSelectedOrdinal(targetOrdinal);
    }
    const locator = projection.segment.locator;
    const page = isPdfLocator(locator) ? Math.max(1, Math.floor(locator.page)) : null;
    const locatorKey = locatorProjectionKey(locator);
    const previous = lastProjectionRef.current;
    const alignment = projection.segment.alignment ?? undefined;
    if (
      previous
      && previous.ordinal === targetOrdinal
      && previous.wordIndex === projection.wordIndex
      && previous.alignment === alignment
      && previous.locatorKey === locatorKey
    ) {
      return;
    }
    lastProjectionRef.current = {
      ordinal: targetOrdinal,
      wordIndex: projection.wordIndex,
      alignment,
      locatorKey,
    };
    setCurrentSentenceAlignment(alignment);
    setCurrentWordIndex(projection.wordIndex);

    if (page !== null) setCurrDocPage(page);
    if (locator) syncPlaybackLocator?.(locator);
  }, [
    playbackSessionRef,
    refreshPlaybackTimeline,
    selectedOrdinalRef,
    setCurrDocPage,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    setSelectedOrdinal,
    syncPlaybackLocator,
  ]);

  const stopPlaybackProjectionLoop = useCallback(() => {
    if (playbackProjectionRafRef.current !== null) {
      cancelAnimationFrame(playbackProjectionRafRef.current);
      playbackProjectionRafRef.current = null;
    }
  }, []);

  const startPlaybackProjectionLoop = useCallback((audio: HTMLAudioElement, runId: number) => {
    stopPlaybackProjectionLoop();
    const tick = () => {
      if (runId !== playbackRunIdRef.current || audio.paused || audio.ended) {
        playbackProjectionRafRef.current = null;
        return;
      }
      const documentTimeSec = documentTimeForAudio(audio);
      publishPlaybackTimeSec(documentTimeSec);
      projectPlaybackTime(documentTimeSec);
      playbackProjectionRafRef.current = requestAnimationFrame(tick);
    };

    const documentTimeSec = documentTimeForAudio(audio);
    publishPlaybackTimeSec(documentTimeSec, { force: true });
    projectPlaybackTime(documentTimeSec);
    playbackProjectionRafRef.current = requestAnimationFrame(tick);
  }, [
    documentTimeForAudio,
    playbackRunIdRef,
    projectPlaybackTime,
    publishPlaybackTimeSec,
    stopPlaybackProjectionLoop,
  ]);

  const resetPlaybackProjection = useCallback(() => {
    stopPlaybackProjectionLoop();
    playbackTimelineRef.current = null;
    playbackStreamBaseSecRef.current = 0;
    lastProjectionRef.current = null;
    playbackCursorOrdinalRef.current = null;
    publishPlaybackTimeSec(0, { force: true });
  }, [publishPlaybackTimeSec, stopPlaybackProjectionLoop]);

  return {
    playbackCursorOrdinalRef,
    playbackStreamBaseSecRef,
    playbackTimeSec,
    documentTimeForAudio,
    projectPlaybackTime,
    publishPlaybackTimeSec,
    refreshPlaybackTimeline,
    resetPlaybackProjection,
    setAudioDocumentTime,
    startPlaybackProjectionLoop,
    stopPlaybackProjectionLoop,
  };
}

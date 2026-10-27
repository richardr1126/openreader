'use client';

import { useCallback, useRef, useState, type MutableRefObject } from 'react';

import {
  documentTimeToMediaTime,
  mediaTimeToDocumentTime,
  mergePlaybackGrid,
  normalizePlaybackGrid,
  projectPlaybackGridAtTime,
  type TtsPlaybackGrid,
  WORD_HIGHLIGHT_LEAD_SEC,
} from '@/lib/client/tts/playback-grid';
import { type TTSSegmentLocator } from '@/types/client';
import type { TTSSentenceAlignment } from '@/types/tts';
import { createPlaybackTimelineLoader } from '@/lib/client/tts/playback-refresh';
import type { TtsPlaybackSeekLayout } from '@/lib/client/api/tts';
import { positionPlaybackMedia } from '@/lib/client/tts/playback-control';
import { measurePlaybackBuffer } from '@openreader/tts/playback-buffer';

export type PlaybackSessionState = {
  sessionId: string;
  sessionInstanceId: string;
  planId: string;
  audioUrl: string;
  timelineUrl: string;
};

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

export function shouldSyncPlaybackLocator(
  previousLocatorKey: string | null | undefined,
  nextLocatorKey: string,
): boolean {
  return nextLocatorKey.length > 0 && previousLocatorKey !== nextLocatorKey;
}

type UsePlaybackProjectionInput = {
  playbackRunIdRef: MutableRefObject<number>;
  playbackSessionRef: MutableRefObject<PlaybackSessionState | null>;
  selectedOrdinalRef: MutableRefObject<number | null>;
  setCurrentSentenceAlignment: (alignment: TTSSentenceAlignment | undefined) => void;
  setCurrentWordIndex: (wordIndex: number | null) => void;
  setSelectedOrdinal: (ordinal: number | null) => void;
  syncPlaybackLocator?: (locator: TTSSegmentLocator | null) => void;
  shouldProject?: () => boolean;
};

export function usePlaybackProjection(input: UsePlaybackProjectionInput) {
  const {
    playbackRunIdRef,
    playbackSessionRef,
    selectedOrdinalRef,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    setSelectedOrdinal,
    syncPlaybackLocator,
    shouldProject,
  } = input;
  const playbackProjectionRafRef = useRef<number | null>(null);
  const mediaPositionAbortRef = useRef<AbortController | null>(null);
  const cancelMediaPosition = useCallback(() => {
    mediaPositionAbortRef.current?.abort();
    mediaPositionAbortRef.current = null;
  }, []);
  const playbackStreamBaseSecRef = useRef(0);
  const playbackStreamStartOrdinalRef = useRef<number | null>(null);
  // Only reuse bytes known to be real audio when this source was opened.
  // A later snapshot can mark audio ready after an old response padded a gap.
  const playbackStreamReadyDurationSecRef = useRef(0);
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
  const timelineLoaderRef = useRef<ReturnType<typeof createPlaybackTimelineLoader<TtsPlaybackGrid>> | null>(null);
  if (!timelineLoaderRef.current) {
    timelineLoaderRef.current = createPlaybackTimelineLoader({
      getRunId: () => playbackRunIdRef.current,
      getSession: () => playbackSessionRef.current,
      apply: (timeline) => {
        // Window rows alone cannot stand in for a grid this tab no longer holds.
        if (timeline.readWindow?.rowsOnly && playbackTimelineRef.current?.sessionId !== timeline.sessionId) return;
        playbackTimelineRef.current = mergePlaybackGrid(playbackTimelineRef.current, timeline);
        const anchor = playbackTimelineRef.current.segments.find((segment) => (
          segment.ordinal === playbackStreamStartOrdinalRef.current
        ));
        // Loading earlier cached chapters changes document coordinates, never
        // the media clock or its source ordinal. Rebase to keep highlighting
        // attached to the same audible segment as the overview arrives.
        if (anchor) playbackStreamBaseSecRef.current = anchor.startMs / 1000;
      },
      load: async (url, signal) => {
        const response = await fetch(url, { cache: 'no-store', signal });
        if (!response.ok) throw new Error(`Failed to load TTS playback timeline: ${response.status}`);
        return normalizePlaybackGrid(await response.json());
      },
    });
  }

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

  const setAudioDocumentTime = useCallback(async (
    audio: HTMLAudioElement,
    documentTimeSec: number,
    targetOrdinal: number,
    targetStartSec: number,
    options?: { reopenStream?: boolean },
  ) => {
    const startedAt = performance.now();
    cancelMediaPosition();
    const controller = new AbortController();
    mediaPositionAbortRef.current = controller;
    const target = Math.max(0, documentTimeSec);
    let base = playbackStreamBaseSecRef.current;
    const mediaTarget = target - base;
    const canReuseBuffer = !audio.error && Boolean(audio.src)
      && mediaTarget >= 0 && mediaTarget < playbackStreamReadyDurationSecRef.current
      && Array.from({ length: audio.buffered?.length ?? 0 }, (_, index) => index)
        .some((index) => mediaTarget >= audio.buffered.start(index) && mediaTarget < audio.buffered.end(index));
    // A nonempty later range proves the earlier bytes are no longer resident.
    // An empty range can simply mean this source is still loading metadata.
    const targetBeforeBuffer = (audio.buffered?.length ?? 0) > 0
      && mediaTarget >= 0 && mediaTarget + 0.25 < audio.buffered.start(0);
    const reopen = Boolean(options?.reopenStream || target + 0.001 < base
      || targetBeforeBuffer
      || (targetOrdinal !== playbackStreamStartOrdinalRef.current && !canReuseBuffer));
    if (reopen) {
      const session = playbackSessionRef.current;
      if (session) {
        const url = new URL(session.audioUrl, window.location.href);
        url.searchParams.set('fromOrdinal', String(Math.max(0, Math.floor(targetOrdinal))));
        base = Math.max(0, targetStartSec);
        playbackStreamBaseSecRef.current = base;
        playbackStreamStartOrdinalRef.current = targetOrdinal;
        playbackStreamReadyDurationSecRef.current = measurePlaybackBuffer({
          segments: playbackTimelineRef.current?.segments ?? [], startOrdinal: targetOrdinal,
        }).durationMs / 1000;
        audio.src = url.toString();
        audio.load();
      }
    }
    try {
      const positioned = await positionPlaybackMedia(audio, documentTimeToMediaTime(target, base), controller.signal);
      if (positioned) console.info('tts.playback.position', JSON.stringify({
        fromOrdinal: targetOrdinal, transport: reopen ? 'reopened' : 'reused',
        durationMs: performance.now() - startedAt,
      }));
      return positioned;
    } finally {
      if (mediaPositionAbortRef.current === controller) mediaPositionAbortRef.current = null;
    }
  }, [cancelMediaPosition, playbackSessionRef]);

  const refreshPlaybackTimeline = useCallback(async (
    timelineUrl: string, signal?: AbortSignal,
    readWindow?: { minOrdinal: number; limit: number },
  ): Promise<TtsPlaybackGrid> => {
    // Holding this session's grid, only the window rows are needed; the merge
    // keeps every other row as it is.
    const rowsOnly = Boolean(playbackTimelineRef.current?.sessionId)
      && playbackTimelineRef.current?.sessionId === playbackSessionRef.current?.sessionId;
    const query = readWindow
      ? `?minOrdinal=${readWindow.minOrdinal}&limit=${readWindow.limit}${rowsOnly ? '&rows=window' : ''}`
      : '';
    await timelineLoaderRef.current!.refresh(timelineUrl + query, signal);
    if (signal?.aborted || !playbackTimelineRef.current) throw new DOMException('Playback timeline replaced', 'AbortError');
    return playbackTimelineRef.current;
  }, [playbackSessionRef]);

  const setPlaybackStreamAnchor = useCallback((ordinal: number, seconds: number) => {
    playbackStreamStartOrdinalRef.current = ordinal;
    playbackStreamBaseSecRef.current = Math.max(0, seconds);
    playbackStreamReadyDurationSecRef.current = measurePlaybackBuffer({
      segments: playbackTimelineRef.current?.segments ?? [], startOrdinal: ordinal,
    }).durationMs / 1000;
  }, []);

  const projectPlaybackTime = useCallback((currentTimeSec: number) => {
    const timeline = playbackTimelineRef.current;
    if (!timeline) return;
    const projection = projectPlaybackGridAtTime(timeline, currentTimeSec, {
      wordLeadSec: WORD_HIGHLIGHT_LEAD_SEC,
    });
    if (!projection.segment) return;

    const targetOrdinal = projection.segment.ordinal;
    playbackCursorOrdinalRef.current = targetOrdinal;
    if (selectedOrdinalRef.current !== targetOrdinal) {
      setSelectedOrdinal(targetOrdinal);
    }
    const locator = projection.segment.locator;
    const locatorKey = locatorProjectionKey(locator);
    const previous = lastProjectionRef.current;
    const shouldSyncLocator = shouldSyncPlaybackLocator(previous?.locatorKey, locatorKey);
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

    if (locator && shouldSyncLocator) syncPlaybackLocator?.(locator);
  }, [
    selectedOrdinalRef,
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
      if (runId !== playbackRunIdRef.current || audio.paused || audio.ended || shouldProject?.() === false) {
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
    shouldProject,
  ]);

  const seedPlaybackTimeline = useCallback((layout: TtsPlaybackSeekLayout, sessionId: string) => {
    playbackTimelineRef.current = normalizePlaybackGrid({ ...layout, sessionId, status: 'queued' });
  }, []);

  const resetPlaybackProjection = useCallback((options?: { preservePosition?: boolean }) => {
    cancelMediaPosition();
    stopPlaybackProjectionLoop();
    timelineLoaderRef.current?.reset();
    playbackTimelineRef.current = null;
    playbackStreamBaseSecRef.current = 0;
    playbackStreamStartOrdinalRef.current = null;
    playbackStreamReadyDurationSecRef.current = 0;
    lastProjectionRef.current = null;
    playbackCursorOrdinalRef.current = null;
    if (!options?.preservePosition) publishPlaybackTimeSec(0, { force: true });
  }, [cancelMediaPosition, publishPlaybackTimeSec, stopPlaybackProjectionLoop]);

  return {
    playbackCursorOrdinalRef,
    playbackTimeSec,
    documentTimeForAudio,
    projectPlaybackTime,
    publishPlaybackTimeSec,
    refreshPlaybackTimeline,
    resetPlaybackProjection,
    seedPlaybackTimeline,
    cancelMediaPosition,
    setAudioDocumentTime,
    setPlaybackStreamAnchor,
    startPlaybackProjectionLoop,
    stopPlaybackProjectionLoop,
  };
}

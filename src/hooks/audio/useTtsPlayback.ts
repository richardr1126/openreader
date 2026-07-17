'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import toast from 'react-hot-toast';
import {
  documentTimeToMediaTime,
  mediaTimeToDocumentTime,
  normalizePlaybackGrid,
  projectPlaybackGridAtTime,
  type TtsPlaybackGrid,
} from '@/lib/client/tts/playback-grid';
import { TTS_PLAYBACK_CURSOR_HEARTBEAT_MS, type TTSLocation, type TTSSentenceAlignment } from '@/types/tts';
import {
  createTtsPlaybackSession,
  getTtsPlaybackSeekLayout,
  postTtsPlaybackCursor,
  subscribeTtsPlaybackEvents,
  type TtsPlaybackPlanPayload,
  type TtsPlaybackSeekLayout,
  type TtsPlaybackSessionPayload,
} from '@/lib/client/api/tts';
import type { TTSRequestHeaders } from '@/types/client';
import { isPdfLocator } from '@/types/client';
import type { TtsPlaybackPlan } from '@/lib/client/tts/playback-plan';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';

export type TtsPlaybackPlanRequest = {
  payload: TtsPlaybackPlanPayload;
  headers: TTSRequestHeaders;
};

export type TtsPlaybackSessionRequest = TtsPlaybackPlanRequest & {
  selectedOrdinal: number;
};

type PlaybackControllerRefs = {
  buildPlaybackPlanRequestRef: MutableRefObject<(() => TtsPlaybackPlanRequest | null) | null>;
  buildPlaybackSessionRequestRef: MutableRefObject<(() => TtsPlaybackSessionRequest | null) | null>;
  createAndApplyPlaybackPlanRef: MutableRefObject<((request: TtsPlaybackPlanRequest, signal?: AbortSignal) => Promise<TtsPlaybackPlan | null>) | null>;
  applyPlaybackPlanRef: MutableRefObject<((plan: TtsPlaybackPlan) => TtsPlaybackPlan) | null>;
};

type UseTtsPlaybackInput = {
  audioContext: AudioContext | null;
  audioSpeed: number;
  canStartPlayback: boolean;
  isPlaying: boolean;
  isPlayingRef: MutableRefObject<boolean>;
  playbackSegmentsRef: MutableRefObject<CanonicalTtsSegment[]>;
  playbackSeekLayout: TtsPlaybackSeekLayout | null;
  selectedOrdinalRef: MutableRefObject<number | null>;
  playbackRunIdRef: MutableRefObject<number>;
  setIsPlaying: (isPlaying: boolean) => void;
  setIsProcessing: (isProcessing: boolean) => void;
  setCurrDocPage: (location: TTSLocation) => void;
  syncPlaybackLocator?: (locator: import('@/types/client').TTSSegmentLocator | null) => void;
  setSelectedOrdinal: (ordinal: number | null) => void;
  setPlaybackSeekLayout: (layout: TtsPlaybackSeekLayout | null) => void;
  setCurrentSentenceAlignment: (alignment: TTSSentenceAlignment | undefined) => void;
  setCurrentWordIndex: (wordIndex: number | null) => void;
  onAdvance: () => void | Promise<void>;
  controllerRefs: PlaybackControllerRefs;
};

const WORD_HIGHLIGHT_LEAD_SEC = 0.12;

// Tiny silent WAV used to unlock HTML5 audio on iOS/Safari.
const SILENT_WAV_DATA_URI =
  'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

export type TtsPlaybackPhase =
  | 'idle'
  | 'planning'
  | 'ready'
  | 'playing'
  | 'seeking'
  | 'buffering'
  | 'ended'
  | 'failed';

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
    audioContext,
    audioSpeed,
    canStartPlayback,
    isPlaying,
    isPlayingRef,
    playbackSegmentsRef,
    playbackSeekLayout,
    selectedOrdinalRef,
    playbackRunIdRef,
    setIsPlaying,
    setIsProcessing,
    setCurrDocPage,
    syncPlaybackLocator,
    setSelectedOrdinal,
    setPlaybackSeekLayout,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    onAdvance,
    controllerRefs,
  } = input;
  const unlockedAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioUnlockAttemptRef = useRef(0);
  const playbackInFlightRef = useRef(false);
  const playbackProjectionRafRef = useRef<number | null>(null);
  // The worker stream is session-relative: byte/time zero is the ordinal where
  // this stream window begins. UI/timeline time remains whole-document time.
  const playbackStreamBaseSecRef = useRef(0);
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
  const pendingResyncRef = useRef<{ ordinal: number } | null>(null);
  const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackRequestHeadersRef = useRef<TTSRequestHeaders | null>(null);
  const [playbackPhase, setPlaybackPhaseState] = useState<TtsPlaybackPhase>('idle');
  const playbackPhaseRef = useRef<TtsPlaybackPhase>('idle');
  const [playbackTimeSec, setPlaybackTimeSec] = useState(0);
  const playbackTimeSecRef = useRef(0);
  const lastPlaybackTimePublishedAtRef = useRef(0);
  const lastProjectionRef = useRef<{
    ordinal: number;
    wordIndex: number | null;
    alignment: TTSSentenceAlignment | null | undefined;
    locatorKey: string;
  } | null>(null);
  // Throttle for the stale-grid self-heal refresh (see projectPlaybackTime).
  const lastTimelineHealAtRef = useRef(0);
  // The single playback cursor: the plan ordinal under the playhead. Written
  // ONLY by the playhead projection (and seeded once at start/seek), so the
  // heartbeat reports exactly the highlighted segment and never a transient
  // selection resets bleeding through reader navigation. `null`
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

  const setPlaybackPhase = useCallback((phase: TtsPlaybackPhase) => {
    playbackPhaseRef.current = phase;
    setPlaybackPhaseState(phase);
  }, []);

  const publishPlaybackTimeSec = useCallback((value: number, options?: { force?: boolean }) => {
    const next = Math.max(0, Number.isFinite(value) ? value : 0);
    playbackTimeSecRef.current = next;
    const now = Date.now();
    const force = Boolean(options?.force);
    if (!force && now - lastPlaybackTimePublishedAtRef.current < 250) return;
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

    // `ordinal` is the authoritative, unique plan index. `segmentKey` is a hash
    // of the segment text and is NOT unique (repeated lines, chapter labels,
    // dividers, refrains), so playback projection must not use it.
    const targetOrdinal = projection.segment.ordinal;
    // The playhead's ordinal IS the cursor. Set it before the dedupe early-return
    // below so the heartbeat always sees the live playhead, even on a tick where
    // the highlight didn't change.
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

    if (page !== null) {
      setCurrDocPage(page);
    }
    if (locator) {
      syncPlaybackLocator?.(locator);
    }
  }, [
    refreshPlaybackTimeline,
    setCurrDocPage,
    syncPlaybackLocator,
    selectedOrdinalRef,
    setSelectedOrdinal,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
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
  }, [documentTimeForAudio, playbackRunIdRef, projectPlaybackTime, publishPlaybackTimeSec, stopPlaybackProjectionLoop]);

  const startPlaybackForegroundSync = useCallback((runId: number, headers: TTSRequestHeaders) => {
    const activeSession = playbackSessionRef.current;
    if (!activeSession) return;

    stopPlaybackTimelinePolling();
    void refreshPlaybackTimeline(activeSession.timelineUrl).catch(() => undefined);
    playbackEventsUnsubRef.current = subscribeTtsPlaybackEvents(activeSession.sessionId, {
      onSnapshot: (snapshot) => {
        if (runId !== playbackRunIdRef.current) return;
        if (snapshot.status === 'failed') return;
        const currentSession = playbackSessionRef.current;
        if (!currentSession) return;
        void refreshPlaybackTimeline(currentSession.timelineUrl)
          .catch(() => undefined);
        if (currentSession.seekLayoutUrl) {
          void getTtsPlaybackSeekLayout(currentSession.seekLayoutUrl)
            .then((layout) => {
              if (runId !== playbackRunIdRef.current) return;
              setPlaybackSeekLayout(layout);
            })
            .catch(() => undefined);
        }
      },
    });

    const writeCursor = () => {
      const currentSession = playbackSessionRef.current;
      if (!currentSession) return;
      // Source the cursor strictly from the playhead projection, not from derived
      // UI indexes. `null` means no faithful playhead yet.
      const cursorOrdinal = playbackCursorOrdinalRef.current;
      if (cursorOrdinal == null) return;
      const cursor = Math.max(0, cursorOrdinal);
      void postTtsPlaybackCursor(currentSession.sessionId, cursor, headers);
    };
    writeCursor();
    playbackCursorIntervalRef.current = setInterval(() => {
      if (runId !== playbackRunIdRef.current) return;
      writeCursor();
    }, TTS_PLAYBACK_CURSOR_HEARTBEAT_MS);
  }, [
    playbackRunIdRef,
    refreshPlaybackTimeline,
    setPlaybackSeekLayout,
    stopPlaybackTimelinePolling,
  ]);

  const stopSeekResync = useCallback(() => {
    if (resyncTimerRef.current) {
      clearTimeout(resyncTimerRef.current);
      resyncTimerRef.current = null;
    }
  }, []);

  const cancelSeekResync = useCallback(() => {
    stopSeekResync();
    pendingResyncRef.current = null;
  }, [stopSeekResync]);

  const invalidatePlaybackRun = useCallback(() => {
    playbackRunIdRef.current += 1;
    playbackInFlightRef.current = false;
  }, [playbackRunIdRef]);

  const isAbortLikeError = useCallback((err: unknown): boolean => {
    if (err instanceof Error) {
      return err.name === 'AbortError' || /abort|cancel/i.test(err.message || '');
    }
    if (typeof err === 'string') {
      return /abort|cancel/i.test(err);
    }
    if (typeof err === 'object' && err !== null && 'message' in err) {
      const maybe = (err as { message?: unknown }).message;
      return typeof maybe === 'string' && /abort|cancel/i.test(maybe);
    }
    return false;
  }, []);

  const unlockPlaybackOnUserGesture = useCallback(() => {
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
      if (playbackActiveRef.current && el.src && el.src !== SILENT_WAV_DATA_URI) {
        return;
      }
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
          .catch(() => undefined);
      }
    } catch {
      // ignore
    }
  }, [audioContext]);

  const resetPlaybackRefs = useCallback(() => {
    stopPlaybackTimelinePolling();
    stopPlaybackProjectionLoop();
    playbackActiveRef.current = false;
    playbackSessionRef.current = null;
    playbackTimelineRef.current = null;
    playbackStreamBaseSecRef.current = 0;
    lastProjectionRef.current = null;
    playbackCursorOrdinalRef.current = null;
    playbackRequestHeadersRef.current = null;
    publishPlaybackTimeSec(0, { force: true });
    setPlaybackPhase('idle');
  }, [publishPlaybackTimeSec, setPlaybackPhase, stopPlaybackProjectionLoop, stopPlaybackTimelinePolling]);

  const abortAudio = useCallback(() => {
    invalidatePlaybackRun();
    cancelSeekResync();
    stopPlaybackProjectionLoop();
    resetPlaybackRefs();
    publishPlaybackTimeSec(0, { force: true });
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
    setCurrentWordIndex(null);
  }, [
    cancelSeekResync,
    invalidatePlaybackRun,
    publishPlaybackTimeSec,
    resetPlaybackRefs,
    setCurrentWordIndex,
    stopPlaybackProjectionLoop,
  ]);

  const pauseActivePlayback = useCallback(() => {
    const audio = unlockedAudioRef.current;
    if (audio) {
      try {
        audio.pause();
      } catch (error) {
        console.warn('Error pausing TTS audio:', error);
      }
    }
    stopPlaybackProjectionLoop();
    stopPlaybackTimelinePolling();
    playbackInFlightRef.current = false;
    setIsProcessing(false);
    setPlaybackPhase('ready');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  }, [setIsProcessing, setPlaybackPhase, stopPlaybackProjectionLoop, stopPlaybackTimelinePolling]);

  const startSeekResync = useCallback((ordinal: number) => {
    pendingResyncRef.current = { ordinal };
    setPlaybackPhase('buffering');
    const runId = playbackRunIdRef.current;
    const deadline = Date.now() + 60_000;
    const tick = async () => {
      const pending = pendingResyncRef.current;
      const session = playbackSessionRef.current;
      if (!pending || pending.ordinal !== ordinal || runId !== playbackRunIdRef.current || !session?.seekLayoutUrl) {
        return;
      }
      if (Date.now() > deadline) {
        pendingResyncRef.current = null;
        setIsProcessing(false);
        return;
      }
      const headers = playbackRequestHeadersRef.current;
      if (headers) void postTtsPlaybackCursor(session.sessionId, ordinal, headers);

      const layout = await getTtsPlaybackSeekLayout(session.seekLayoutUrl).catch(() => null);
      if (runId !== playbackRunIdRef.current || pendingResyncRef.current?.ordinal !== ordinal) return;
      const slot = layout?.segments.find((segment) => segment.ordinal === ordinal) ?? null;

      if (slot?.generated) {
        if (layout) setPlaybackSeekLayout(layout);
        await refreshPlaybackTimeline(session.timelineUrl).catch(() => undefined);
        if (runId !== playbackRunIdRef.current || pendingResyncRef.current?.ordinal !== ordinal) return;
        const targetSec = Math.max(0, slot.startMs / 1000);
        setSelectedOrdinal(ordinal);
        const audio = unlockedAudioRef.current;
        if (audio && playbackActiveRef.current && audio.src) {
          try {
            setAudioDocumentTime(audio, targetSec, ordinal, targetSec);
          } catch {
            // Best-effort; projection below still updates the UI.
          }
          if (isPlayingRef.current) {
            audio.playbackRate = audioSpeed;
            void audio.play().catch(() => undefined);
            setPlaybackPhase('playing');
          } else {
            setPlaybackPhase('ready');
          }
        }
        publishPlaybackTimeSec(targetSec, { force: true });
        projectPlaybackTime(targetSec);
        pendingResyncRef.current = null;
        setIsProcessing(false);
        return;
      }

      resyncTimerRef.current = setTimeout(() => { void tick(); }, 600);
    };
    stopSeekResync();
    void tick();
  }, [
    audioSpeed,
    isPlayingRef,
    playbackRunIdRef,
    projectPlaybackTime,
    publishPlaybackTimeSec,
    refreshPlaybackTimeline,
    setIsProcessing,
    setPlaybackPhase,
    setPlaybackSeekLayout,
    setSelectedOrdinal,
    setAudioDocumentTime,
    stopSeekResync,
  ]);

  const seekPlaybackTo = useCallback((seconds: number) => {
    const layout = playbackSeekLayout;
    if (!layout || layout.segments.length === 0) return;
    setPlaybackPhase('seeking');
    const durationSec = Math.max(0, layout.durationMs / 1000);
    const targetSec = Math.max(0, Math.min(seconds, durationSec));
    const targetMs = targetSec * 1000;
    const target = layout.segments.find((segment) => targetMs >= segment.startMs && targetMs < segment.endMs)
      ?? layout.segments[layout.segments.length - 1];
    if (!target) return;

    const targetStartSec = Math.max(0, target.startMs / 1000);
    publishPlaybackTimeSec(target.generated ? targetSec : targetStartSec, { force: true });
    setSelectedOrdinal(target.ordinal);
    if (target.locator && typeof target.locator === 'object') {
      syncPlaybackLocator?.(target.locator as import('@/types/client').TTSSegmentLocator);
    }

    const session = playbackSessionRef.current;
    const headers = playbackRequestHeadersRef.current;
    if (session && headers) {
      void postTtsPlaybackCursor(session.sessionId, target.ordinal, headers);
    }

    const audio = unlockedAudioRef.current;

    if (target.generated) {
      cancelSeekResync();
      setIsProcessing(false);
      if (audio && playbackActiveRef.current && audio.src) {
        try {
          setAudioDocumentTime(audio, targetSec, target.ordinal, targetStartSec);
        } catch {
          // Best-effort; the projection still updates immediately below.
        }
        if (isPlayingRef.current) {
          audio.playbackRate = audioSpeed;
          void audio.play().catch(() => undefined);
          setPlaybackPhase('playing');
        } else {
          setPlaybackPhase('ready');
        }
      }
      projectPlaybackTime(targetSec);
      return;
    }

    if (isPlayingRef.current && audio) {
      try {
        audio.pause();
      } catch {
        // ignore
      }
      setIsProcessing(true);
      setPlaybackPhase('buffering');
    }
    if (audio && playbackActiveRef.current && audio.src) {
      try {
        setAudioDocumentTime(audio, targetStartSec, target.ordinal, targetStartSec);
      } catch {
        // Best-effort; the resync re-seeks accurately when the audio is ready.
      }
    }
    projectPlaybackTime(targetStartSec);
    startSeekResync(target.ordinal);
  }, [
    audioSpeed,
    cancelSeekResync,
    isPlayingRef,
    playbackSeekLayout,
    projectPlaybackTime,
    publishPlaybackTimeSec,
    setIsProcessing,
    setPlaybackPhase,
    setSelectedOrdinal,
    setAudioDocumentTime,
    startSeekResync,
    syncPlaybackLocator,
  ]);

  const seekPlaybackToOrdinal = useCallback((ordinal: number): boolean => {
    const layout = playbackSeekLayout;
    if (!layout || !Number.isFinite(ordinal)) return false;
    const target = layout.segments.find((entry) => entry.ordinal === Math.max(0, Math.floor(ordinal)));
    if (!target) return false;
    seekPlaybackTo(target.startMs / 1000);
    return true;
  }, [playbackSeekLayout, seekPlaybackTo]);

  const playWorkerPlaybackStream = useCallback(async () => {
    const runId = playbackRunIdRef.current;
    const request = controllerRefs.buildPlaybackPlanRequestRef.current?.() ?? null;
    if (!request) {
      playbackInFlightRef.current = false;
      setIsProcessing(false);
      return;
    }

    setIsProcessing(true);
    setPlaybackPhase('planning');
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
      const plan = await controllerRefs.createAndApplyPlaybackPlanRef.current?.(request);
      if (runId !== playbackRunIdRef.current) return;
      if (!plan?.planObjectKey) {
        throw new Error('TTS playback plan was not ready in time');
      }
      const sessionRequest = controllerRefs.buildPlaybackSessionRequestRef.current?.() ?? null;
      const selectedOrdinal = sessionRequest?.selectedOrdinal;
      if (!sessionRequest || !Number.isFinite(Number(selectedOrdinal))) {
        throw new Error('TTS playback requires a selected worker-plan segment');
      }
      const { payload, headers } = sessionRequest;
      const sessionPayload: TtsPlaybackSessionPayload = {
        documentId: payload.documentId,
        settings: payload.settings,
        ...(payload.planning ? { planning: payload.planning } : {}),
        startIntent: { selectedOrdinal: Math.max(0, Math.floor(Number(selectedOrdinal))) },
        ...(plan.planId ? { planId: plan.planId } : {}),
        planObjectKey: plan.planObjectKey,
        ...(plan.planSignature ? { planSignature: plan.planSignature } : {}),
      };
      const session = await createTtsPlaybackSession(sessionPayload, headers);
      if (runId !== playbackRunIdRef.current) return;

      playbackSessionRef.current = {
        sessionId: session.sessionId,
        audioUrl: session.audioUrl,
        timelineUrl: session.timelineUrl,
        seekLayoutUrl: session.seekLayoutUrl,
      };
      playbackRequestHeadersRef.current = headers;
      setPlaybackPhase('ready');

      controllerRefs.applyPlaybackPlanRef.current?.(plan);

      const initialSeekLayout = await (async () => {
        const deadline = Date.now() + 20_000;
        for (;;) {
          if (runId !== playbackRunIdRef.current) return null;
          const layout = await getTtsPlaybackSeekLayout(session.seekLayoutUrl).catch(() => null);
          if (layout?.status === 'running' || layout?.status === 'succeeded') return layout;
          if (Date.now() > deadline) {
            throw new Error('TTS playback session did not expose a worker-resolved start ordinal in time');
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      })();
      if (runId !== playbackRunIdRef.current || !initialSeekLayout) return;
      setPlaybackSeekLayout(initialSeekLayout);
      await refreshPlaybackTimeline(session.timelineUrl);
      if (runId !== playbackRunIdRef.current) return;

      const initialStartSec = (() => {
        const startOrdinal = initialSeekLayout.generationStartOrdinal;
        const planIndex = playbackSegmentsRef.current.findIndex((segment) => segment.ordinal === startOrdinal);
        if (planIndex < 0) {
          throw new Error(`TTS playback start ordinal ${startOrdinal} is not present in the canonical plan`);
        }
        setSelectedOrdinal(startOrdinal);
        playbackCursorOrdinalRef.current = startOrdinal;
        const slot = initialSeekLayout.segments.find((segment) => segment.ordinal === startOrdinal);
        if (!slot) {
          throw new Error(`TTS playback start ordinal ${startOrdinal} is not present in the seek layout`);
        }
        return Math.max(0, slot.startMs / 1000);
      })();

      let audio = unlockedAudioRef.current;
      if (!audio) {
        audio = new Audio();
        audio.preload = 'auto';
        audio.setAttribute('playsinline', 'true');
        unlockedAudioRef.current = audio;
      }
      audio.defaultPlaybackRate = audioSpeed;
      audio.playbackRate = audioSpeed;
      audio.volume = 1;
      audio.onplay = () => {
        if (runId !== playbackRunIdRef.current) return;
        setPlaybackPhase('playing');
        audio.playbackRate = audioSpeed;
        startPlaybackProjectionLoop(audio, runId);
        setIsProcessing(false);
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
      };
      audio.onpause = () => {
        if (runId !== playbackRunIdRef.current) return;
        stopPlaybackProjectionLoop();
        playbackInFlightRef.current = false;
        setPlaybackPhase('ready');
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'paused';
        }
      };
      audio.onended = () => {
        if (runId !== playbackRunIdRef.current) return;
        stopPlaybackProjectionLoop();
        playbackInFlightRef.current = false;
        setIsProcessing(false);
        resetPlaybackRefs();
        setPlaybackPhase('ended');
        playbackRequestHeadersRef.current = null;
        if (isPlayingRef.current) {
          void onAdvance();
        }
      };
      audio.onerror = () => {
        if (runId !== playbackRunIdRef.current) return;
        stopPlaybackProjectionLoop();
        playbackInFlightRef.current = false;
        setIsProcessing(false);
        resetPlaybackRefs();
        setPlaybackPhase('failed');
        playbackRequestHeadersRef.current = null;
        setIsPlaying(false);
        toast.error('TTS playback failed. Paused playback.', {
          id: 'tts-playback-error',
          duration: 7000,
        });
      };
      audio.ontimeupdate = () => {
        if (runId !== playbackRunIdRef.current) return;
        setIsProcessing(false);
        const documentTimeSec = documentTimeForAudio(audio);
        publishPlaybackTimeSec(documentTimeSec, { force: true });
        projectPlaybackTime(documentTimeSec);
      };
      audio.onwaiting = () => {
        if (runId !== playbackRunIdRef.current) return;
        setPlaybackPhase('buffering');
        setIsProcessing(true);
      };
      audio.onstalled = null;
      audio.onplaying = () => {
        if (runId !== playbackRunIdRef.current) return;
        setPlaybackPhase('playing');
        startPlaybackProjectionLoop(audio, runId);
        setIsProcessing(false);
      };

      startPlaybackForegroundSync(runId, headers);

      playbackActiveRef.current = true;
      playbackStreamBaseSecRef.current = initialStartSec;
      audio.src = session.audioUrl;
      audio.load();
      publishPlaybackTimeSec(initialStartSec, { force: true });
      projectPlaybackTime(initialStartSec);
      await audio.play();
      if (runId === playbackRunIdRef.current && !audio.paused && !audio.ended) {
        startPlaybackProjectionLoop(audio, runId);
      }
    } catch (error) {
      if (runId !== playbackRunIdRef.current || isAbortLikeError(error)) return;
      console.error('Error playing TTS playback:', error);
      stopPlaybackProjectionLoop();
      playbackInFlightRef.current = false;
      setIsProcessing(false);
      resetPlaybackRefs();
      setIsPlaying(false);
      setPlaybackPhase('failed');
      toast.error('TTS playback failed. Paused playback.', {
        id: 'tts-playback-error',
        duration: 7000,
      });
    }
  }, [
    audioSpeed,
    controllerRefs,
    documentTimeForAudio,
    isAbortLikeError,
    isPlayingRef,
    onAdvance,
    playbackRunIdRef,
    playbackSegmentsRef,
    projectPlaybackTime,
    publishPlaybackTimeSec,
    refreshPlaybackTimeline,
    resetPlaybackRefs,
    setIsPlaying,
    setIsProcessing,
    setPlaybackPhase,
    setPlaybackSeekLayout,
    setSelectedOrdinal,
    startPlaybackForegroundSync,
    startPlaybackProjectionLoop,
    stopPlaybackProjectionLoop,
  ]);

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      cancelSeekResync();
      setIsProcessing(false);
      pauseActivePlayback();
      setIsPlaying(false);
      return;
    }

    if (pendingResyncRef.current) {
      unlockPlaybackOnUserGesture();
      setIsProcessing(true);
      setPlaybackPhase('buffering');
      isPlayingRef.current = true;
      setIsPlaying(true);
      startSeekResync(pendingResyncRef.current.ordinal);
      return;
    }

    unlockPlaybackOnUserGesture();

    const audio = unlockedAudioRef.current;
    if (audio && playbackActiveRef.current && audio.src) {
      const headers = playbackRequestHeadersRef.current;
      if (headers) {
        startPlaybackForegroundSync(playbackRunIdRef.current, headers);
      }
      audio.playbackRate = audioSpeed;
      playbackInFlightRef.current = true;
      audio.play()
        .then(() => {
          setPlaybackPhase('playing');
          setIsPlaying(true);
        })
        .catch((error) => {
          console.warn('Error resuming TTS audio:', error);
          playbackInFlightRef.current = false;
          resetPlaybackRefs();
          setIsPlaying(false);
          setPlaybackPhase('failed');
        });
      return;
    }

    setIsPlaying(true);
  }, [
    audioSpeed,
    cancelSeekResync,
    isPlaying,
    isPlayingRef,
    pauseActivePlayback,
    playbackRunIdRef,
    resetPlaybackRefs,
    setIsPlaying,
    setIsProcessing,
    setPlaybackPhase,
    startPlaybackForegroundSync,
    startSeekResync,
    unlockPlaybackOnUserGesture,
  ]);

  useEffect(() => {
    if (!isPlaying) {
      playbackInFlightRef.current = false;
      return;
    }
    if (!canStartPlayback) return;
    if (playbackInFlightRef.current) return;
    playbackInFlightRef.current = true;
    void playWorkerPlaybackStream();
  }, [canStartPlayback, isPlaying, playWorkerPlaybackStream]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'visible') return;
      if (!playbackActiveRef.current) return;
      const session = playbackSessionRef.current;
      const audio = unlockedAudioRef.current;
      if (!session || !audio || audio.paused || audio.ended) return;
      void refreshPlaybackTimeline(session.timelineUrl)
        .then(() => {
          if (!playbackActiveRef.current || audio.paused || audio.ended) return;
          projectPlaybackTime(documentTimeForAudio(audio));
        })
        .catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [documentTimeForAudio, projectPlaybackTime, refreshPlaybackTimeline]);

  return {
    unlockedAudioRef,
    playbackActiveRef,
    playbackCursorIntervalRef,
    playbackCursorOrdinalRef,
    playbackEventsUnsubRef,
    playbackPhase,
    playbackPhaseRef,
    playbackTimeSec,
    publishPlaybackTimeSec,
    playbackSessionRef,
    projectPlaybackTime,
    refreshPlaybackTimeline,
    resetPlaybackRefs,
    setPlaybackPhase,
    abortAudio,
    cancelSeekResync,
    invalidatePlaybackRun,
    pauseActivePlayback,
    playWorkerPlaybackStream,
    seekPlaybackTo,
    seekPlaybackToOrdinal,
    startSeekResync,
    unlockPlaybackOnUserGesture,
    togglePlay,
    startPlaybackForegroundSync,
    startPlaybackProjectionLoop,
    stopPlaybackProjectionLoop,
    stopPlaybackTimelinePolling,
  };
}

'use client';

import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import toast from 'react-hot-toast';
import { type TTSLocation, type TTSSentenceAlignment } from '@/types/tts';
import {
  createTtsPlaybackSession,
  getTtsPlaybackSeekLayout,
  postTtsPlaybackCursor,
  type TtsPlaybackPlanPayload,
  type TtsPlaybackSeekLayout,
  type TtsPlaybackSessionPayload,
} from '@/lib/client/api/tts';
import type { TTSRequestHeaders } from '@/types/client';
import type { TtsPlaybackPlan } from '@/lib/client/tts/playback-plan';
import { usePlaybackForegroundSync } from '@/hooks/audio/usePlaybackForegroundSync';
import {
  usePlaybackProjection,
  type PlaybackSessionState,
} from '@/hooks/audio/usePlaybackProjection';
import type { CanonicalTtsSegment } from '@openreader/tts/segment-plan';

export type TtsPlaybackPlanRequest = {
  payload: TtsPlaybackPlanPayload;
  headers: TTSRequestHeaders;
};

export type TtsPlaybackSessionRequest = TtsPlaybackPlanRequest & {
  selectedOrdinal: number;
};

type PlaybackController = {
  buildPlaybackPlanRequest: () => TtsPlaybackPlanRequest | null;
  buildPlaybackSessionRequest: () => TtsPlaybackSessionRequest | null;
  createAndApplyPlaybackPlan: (request: TtsPlaybackPlanRequest, signal?: AbortSignal) => Promise<TtsPlaybackPlan | null>;
  applyPlaybackPlan: (plan: TtsPlaybackPlan) => TtsPlaybackPlan;
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
  controller: PlaybackController;
};

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
    controller,
  } = input;
  const unlockedAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioUnlockAttemptRef = useRef(0);
  const playbackInFlightRef = useRef(false);
  const playbackSessionRef = useRef<PlaybackSessionState | null>(null);
  const playbackActiveRef = useRef(false);
  const pendingResyncRef = useRef<{ ordinal: number } | null>(null);
  const resyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackRequestHeadersRef = useRef<TTSRequestHeaders | null>(null);
  const playbackPhaseRef = useRef<TtsPlaybackPhase>('idle');

  const setPlaybackPhase = useCallback((phase: TtsPlaybackPhase) => {
    playbackPhaseRef.current = phase;
  }, []);

  const {
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
  } = usePlaybackProjection({
    playbackRunIdRef,
    playbackSessionRef,
    selectedOrdinalRef,
    setCurrDocPage,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    setSelectedOrdinal,
    syncPlaybackLocator,
  });
  const {
    startPlaybackForegroundSync,
    stopPlaybackForegroundSync,
  } = usePlaybackForegroundSync({
    playbackCursorOrdinalRef,
    playbackRunIdRef,
    playbackSessionRef,
    refreshPlaybackTimeline,
    setPlaybackSeekLayout,
  });

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
    stopPlaybackForegroundSync();
    playbackActiveRef.current = false;
    playbackSessionRef.current = null;
    playbackRequestHeadersRef.current = null;
    resetPlaybackProjection();
    setPlaybackPhase('idle');
  }, [resetPlaybackProjection, setPlaybackPhase, stopPlaybackForegroundSync]);

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
    stopPlaybackForegroundSync();
    playbackInFlightRef.current = false;
    setIsProcessing(false);
    setPlaybackPhase('ready');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  }, [setIsProcessing, setPlaybackPhase, stopPlaybackForegroundSync, stopPlaybackProjectionLoop]);

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
    const request = controller.buildPlaybackPlanRequest();
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
      const plan = await controller.createAndApplyPlaybackPlan(request);
      if (runId !== playbackRunIdRef.current) return;
      if (!plan?.planObjectKey) {
        throw new Error('TTS playback plan was not ready in time');
      }
      const sessionRequest = controller.buildPlaybackSessionRequest();
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

      controller.applyPlaybackPlan(plan);

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
    controller,
    documentTimeForAudio,
    isAbortLikeError,
    isPlayingRef,
    onAdvance,
    playbackCursorOrdinalRef,
    playbackRunIdRef,
    playbackSegmentsRef,
    playbackStreamBaseSecRef,
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
    playbackTimeSec,
    publishPlaybackTimeSec,
    abortAudio,
    cancelSeekResync,
    invalidatePlaybackRun,
    pauseActivePlayback,
    seekPlaybackTo,
    seekPlaybackToOrdinal,
    togglePlay,
  };
}

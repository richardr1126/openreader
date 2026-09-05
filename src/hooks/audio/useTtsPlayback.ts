'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import toast from 'react-hot-toast';
import {
  type TTSLocation,
  type TTSSentenceAlignment,
  type TtsPlaybackPhase,
} from '@/types/tts';
import {
  createTtsPlaybackSession,
  getTtsPlaybackSeekLayout,
  postTtsPlaybackCursor,
  type TtsPlaybackPlanPayload,
  type TtsPlaybackSeekLayout,
  type TtsPlaybackSessionPayload,
} from '@/lib/client/api/tts';
import type { TTSRequestHeaders } from '@/types/client';
import type { TtsPlaybackPlan } from '@/lib/shared/playback-plan';
import {
  isPlaybackAbortError,
  isPlaybackStartBufferReady,
  resumePlaybackMedia,
  waitForPlaybackStartBuffer,
} from '@/lib/client/tts/playback-control';
import { usePlaybackMediaResume } from '@/hooks/audio/usePlaybackMediaResume';
import { createPlaybackRecovery, createTtsMediaRecovery } from '@/lib/client/tts/playback-recovery';
import { installPlaybackMediaEvents } from '@/lib/client/tts/playback-media-events';
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
  getPlaybackPlan: () => TtsPlaybackPlan | null;
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
  const playbackRequestAbortRef = useRef<AbortController | null>(null);
  const playbackRecoveryRef = useRef<ReturnType<typeof createPlaybackRecovery> | null>(null);
  const latestSeekLayoutRef = useRef(playbackSeekLayout);
  latestSeekLayoutRef.current = playbackSeekLayout;
  const checkRecovery = useCallback(() => { playbackRecoveryRef.current?.check(); }, []);
  const playbackPhaseRef = useRef<TtsPlaybackPhase>('idle');
  const [playbackPhase, setPlaybackPhaseState] = useState<TtsPlaybackPhase>('idle');

  const setPlaybackPhase = useCallback((phase: TtsPlaybackPhase) => {
    playbackPhaseRef.current = phase;
    setPlaybackPhaseState(phase);
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
    setWorkerPlaybackActive,
    startPlaybackForegroundSync,
    stopPlaybackForegroundSync,
  } = usePlaybackForegroundSync({
    playbackCursorOrdinalRef,
    playbackRequestHeadersRef,
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
    playbackRecoveryRef.current?.stop();
    playbackRecoveryRef.current = null;
    playbackInFlightRef.current = false;
    playbackRequestAbortRef.current?.abort();
    playbackRequestAbortRef.current = null;
  }, [playbackRunIdRef]);

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
    playbackRecoveryRef.current?.stop();
    playbackRecoveryRef.current = null;
    stopPlaybackForegroundSync();
    playbackActiveRef.current = false;
    playbackSessionRef.current = null;
    playbackRequestHeadersRef.current = null;
    resetPlaybackProjection();
    setPlaybackPhase('idle');
  }, [resetPlaybackProjection, setPlaybackPhase, stopPlaybackForegroundSync]);

  const abortAudio = useCallback(() => {
    setWorkerPlaybackActive(false);
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
    setWorkerPlaybackActive,
    setCurrentWordIndex,
    stopPlaybackProjectionLoop,
  ]);

  const pauseActivePlayback = useCallback(() => {
    if (!playbackActiveRef.current) invalidatePlaybackRun();
    isPlayingRef.current = false;
    setWorkerPlaybackActive(false);
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
  }, [
    invalidatePlaybackRun,
    isPlayingRef,
    setIsProcessing,
    setPlaybackPhase,
    setWorkerPlaybackActive,
    stopPlaybackForegroundSync,
    stopPlaybackProjectionLoop,
  ]);

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
      if (headers) void postTtsPlaybackCursor(session.sessionId, ordinal, headers, { sessionInstanceId: session.sessionInstanceId });

      const layout = await getTtsPlaybackSeekLayout(session.seekLayoutUrl).catch(() => null);
      if (runId !== playbackRunIdRef.current || pendingResyncRef.current?.ordinal !== ordinal) return;
      const slot = layout?.segments.find((segment) => segment.ordinal === ordinal) ?? null;

      if (slot?.generated && layout && isPlaybackStartBufferReady({
        segments: layout.segments,
        startOrdinal: ordinal,
        playbackRate: audioSpeed,
      })) {
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
      void postTtsPlaybackCursor(session.sessionId, target.ordinal, headers, { sessionInstanceId: session.sessionInstanceId });
    }

    const audio = unlockedAudioRef.current;

    const hasReadyBuffer = target.generated && isPlaybackStartBufferReady({
      segments: layout.segments,
      startOrdinal: target.ordinal,
      playbackRate: audioSpeed,
      offsetWithinStartSegmentMs: Math.max(0, targetMs - target.startMs),
    });

    if (hasReadyBuffer) {
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

  const syncActivePlaybackToOrdinal = useCallback((ordinal: number): boolean => {
    if (!playbackActiveRef.current || !playbackSessionRef.current) return false;
    return seekPlaybackToOrdinal(ordinal);
  }, [seekPlaybackToOrdinal]);

  const playWorkerPlaybackStream = useCallback(async () => {
    const runId = playbackRunIdRef.current;
    const request = controller.buildPlaybackPlanRequest();
    if (!request) {
      playbackInFlightRef.current = false;
      setIsProcessing(false);
      return;
    }

    resetPlaybackRefs();
    setIsProcessing(true);
    setPlaybackPhase('planning');
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
      const plan = controller.getPlaybackPlan();
      if (runId !== playbackRunIdRef.current) return;
      if (!plan?.planObjectKey) {
        throw new Error('The bootstrap playback plan is not ready');
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
      const requestController = new AbortController();
      playbackRequestAbortRef.current?.abort();
      playbackRequestAbortRef.current = requestController;
      const session = await (async () => {
        try {
          return await createTtsPlaybackSession(sessionPayload, headers, requestController.signal);
        } finally {
          if (playbackRequestAbortRef.current === requestController) {
            playbackRequestAbortRef.current = null;
          }
        }
      })();
      if (runId !== playbackRunIdRef.current) return;

      playbackSessionRef.current = {
        sessionId: session.sessionId,
        sessionInstanceId: session.sessionInstanceId,
        audioUrl: session.audioUrl,
        timelineUrl: session.timelineUrl,
        seekLayoutUrl: session.seekLayoutUrl,
      };
      playbackRequestHeadersRef.current = headers;
      setPlaybackPhase('ready');

      controller.applyPlaybackPlan(plan);

      const requestedStartOrdinal = Math.max(0, Math.floor(Number(selectedOrdinal)));
      playbackCursorOrdinalRef.current = requestedStartOrdinal;
      await setWorkerPlaybackActive(true, true);
      if (runId !== playbackRunIdRef.current || !isPlayingRef.current) return;
      startPlaybackForegroundSync(runId, headers);

      const initialSeekLayout = await waitForPlaybackStartBuffer({
        loadLayout: () => getTtsPlaybackSeekLayout(session.seekLayoutUrl).catch(() => null),
        isCurrent: () => runId === playbackRunIdRef.current,
        playbackRate: audioSpeed,
      });
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
      const recover = () => { setPlaybackPhase('buffering'); setIsProcessing(true); checkRecovery(); };
      installPlaybackMediaEvents({ audio, audioSpeed,
        isCurrent: () => runId === playbackRunIdRef.current,
        isPlaying: () => isPlayingRef.current,
        shouldRecoverEnd: () => {
          const last = latestSeekLayoutRef.current?.segments.at(-1)?.ordinal;
          return last !== undefined && (playbackCursorOrdinalRef.current ?? 0) < last;
        },
        onPause: () => {
          stopPlaybackProjectionLoop();
          playbackInFlightRef.current = isPlayingRef.current;
          setPlaybackPhase(isPlayingRef.current ? 'buffering' : 'ready');
        },
        onBuffering: recover, onRecover: recover,
        onEnded: () => {
          setWorkerPlaybackActive(false); stopPlaybackProjectionLoop();
          playbackInFlightRef.current = false; setIsProcessing(false); resetPlaybackRefs();
          setPlaybackPhase('ended'); playbackRequestHeadersRef.current = null;
          if (isPlayingRef.current) void onAdvance();
        },
        onTime: () => {
          const documentTimeSec = documentTimeForAudio(audio);
          publishPlaybackTimeSec(documentTimeSec, { force: true });
          projectPlaybackTime(documentTimeSec);
        },
        onPlaying: () => {
          setPlaybackPhase('playing'); startPlaybackProjectionLoop(audio, runId); setIsProcessing(false);
        },
      });

      playbackActiveRef.current = true;
      playbackStreamBaseSecRef.current = initialStartSec;
      audio.src = session.audioUrl;
      audio.load();
      const activeSession = playbackSessionRef.current;
      playbackRecoveryRef.current = createTtsMediaRecovery({
        audio,
        sessionUrl: session.audioUrl,
        isCurrent: () => runId === playbackRunIdRef.current && isPlayingRef.current
          && playbackActiveRef.current && playbackSessionRef.current === activeSession
          && !pendingResyncRef.current,
        getDocumentTime: () => documentTimeForAudio(audio),
        getOrdinal: () => playbackCursorOrdinalRef.current,
        getLayout: () => latestSeekLayoutRef.current,
        setStreamBase: (seconds) => { playbackStreamBaseSecRef.current = seconds; },
        onBuffering: () => {
          setPlaybackPhase('buffering');
          setIsProcessing(true);
        },
        onExhausted: () => {
          pauseActivePlayback();
          setIsPlaying(false);
          setPlaybackPhase('failed');
          toast.error('Audio is ready, but playback could not reconnect. Try Play again.', { id: 'tts-playback-error' });
        },
      });
      publishPlaybackTimeSec(initialStartSec, { force: true });
      projectPlaybackTime(initialStartSec);
      const started = await resumePlaybackMedia(() => audio.play(), () => (
        runId === playbackRunIdRef.current && isPlayingRef.current
      ));
      if (started.status === 'stale') checkRecovery();
      if (runId === playbackRunIdRef.current && !audio.paused && !audio.ended) {
        startPlaybackProjectionLoop(audio, runId);
      }
    } catch (error) {
      if (runId !== playbackRunIdRef.current || isPlaybackAbortError(error)) return;
      console.error('Error playing TTS playback:', error);
      setWorkerPlaybackActive(false);
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
    checkRecovery,
    documentTimeForAudio,
    isPlayingRef,
    onAdvance,
    pauseActivePlayback,
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
    setWorkerPlaybackActive,
    startPlaybackForegroundSync,
    startPlaybackProjectionLoop,
    stopPlaybackProjectionLoop,
  ]);

  const resumeActivePlayback = usePlaybackMediaResume({
    audioSpeed,
    isPlayingRef,
    playbackInFlightRef,
    playbackRequestHeadersRef,
    playbackRunIdRef,
    checkRecovery,
    setIsPlaying,
    setIsProcessing,
    setPlaybackPhase,
    setWorkerPlaybackActive,
    startPlaybackForegroundSync,
  });

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
      setWorkerPlaybackActive(true);
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
      resumeActivePlayback(audio);
      return;
    }

    isPlayingRef.current = true;
    setIsPlaying(true);
  }, [
    cancelSeekResync,
    isPlaying,
    isPlayingRef,
    pauseActivePlayback,
    resumeActivePlayback,
    setIsPlaying,
    setIsProcessing,
    setPlaybackPhase,
    setWorkerPlaybackActive,
    startSeekResync,
    unlockPlaybackOnUserGesture,
  ]);

  useEffect(() => {
    if (!isPlaying) {
      playbackInFlightRef.current = false;
      return;
    }
    if (!canStartPlayback) return;
    if (playbackActiveRef.current) return;
    if (playbackInFlightRef.current) return;
    playbackInFlightRef.current = true;
    void playWorkerPlaybackStream();
  }, [canStartPlayback, isPlaying, playWorkerPlaybackStream]);

  useEffect(() => () => { playbackRecoveryRef.current?.stop(); }, []);

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
    playbackPhase,
    playbackTimeSec,
    publishPlaybackTimeSec,
    abortAudio,
    cancelSeekResync,
    invalidatePlaybackRun,
    pauseActivePlayback,
    seekPlaybackTo,
    seekPlaybackToOrdinal,
    syncActivePlaybackToOrdinal,
    togglePlay,
  };
}

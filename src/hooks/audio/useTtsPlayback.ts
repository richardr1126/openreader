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
  type TtsPlaybackPlanPayload,
  type TtsPlaybackSeekLayout,
  type TtsPlaybackSessionPayload,
} from '@/lib/client/api/tts';
import type { TTSRequestHeaders } from '@/types/client';
import type { TtsPlaybackPlan } from '@/lib/shared/playback-plan';
import {
  isPlaybackAbortError,
  resumePlaybackMedia,
  waitForPlaybackStartBuffer,
} from '@/lib/client/tts/playback-control';
import { usePlaybackAudioElement } from '@/hooks/audio/usePlaybackAudioElement';
import { usePlaybackMediaResume } from '@/hooks/audio/usePlaybackMediaResume';
import { usePlaybackSeek } from '@/hooks/audio/usePlaybackSeek';
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
  setCurrDocPage: (location: TTSLocation) => void;
  syncPlaybackLocator?: (locator: import('@/types/client').TTSSegmentLocator | null) => void;
  setSelectedOrdinal: (ordinal: number | null) => void;
  setPlaybackSeekLayout: (layout: TtsPlaybackSeekLayout | null) => void;
  setCurrentSentenceAlignment: (alignment: TTSSentenceAlignment | undefined) => void;
  setCurrentWordIndex: (wordIndex: number | null) => void;
  onAdvance: () => void | Promise<void>;
  controller: PlaybackController;
};

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
    setCurrDocPage,
    syncPlaybackLocator,
    setSelectedOrdinal,
    setPlaybackSeekLayout,
    setCurrentSentenceAlignment,
    setCurrentWordIndex,
    onAdvance,
    controller,
  } = input;
  const playbackInFlightRef = useRef(false);
  const playbackSessionRef = useRef<PlaybackSessionState | null>(null);
  const playbackActiveRef = useRef(false);
  const playbackRequestHeadersRef = useRef<TTSRequestHeaders | null>(null);
  const playbackRequestAbortRef = useRef<AbortController | null>(null);
  const playbackRecoveryRef = useRef<ReturnType<typeof createPlaybackRecovery> | null>(null);
  const latestSeekLayoutRef = useRef(playbackSeekLayout);
  useEffect(() => {
    const activeSessionId = playbackSessionRef.current?.sessionId;
    if (playbackSeekLayout && activeSessionId && playbackSeekLayout.sessionId !== activeSessionId) return;
    latestSeekLayoutRef.current = playbackSeekLayout;
  }, [playbackSeekLayout]);
  const setActivePlaybackSeekLayout = useCallback((layout: TtsPlaybackSeekLayout | null) => {
    const activeSessionId = playbackSessionRef.current?.sessionId;
    if (layout && (!activeSessionId || layout.sessionId !== activeSessionId)) return;
    latestSeekLayoutRef.current = layout;
    setPlaybackSeekLayout(layout);
  }, [setPlaybackSeekLayout]);
  const checkRecovery = useCallback(() => { playbackRecoveryRef.current?.check(); }, []);
  const [playbackPhase, setPlaybackPhase] = useState<TtsPlaybackPhase>('idle');
  const {
    audioRef: unlockedAudioRef,
    clearAudioSource,
    ensureAudio,
    unlockAudioOnUserGesture,
  } = usePlaybackAudioElement({ audioContext, audioSpeed });

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
    updateWorkerPlaybackCursor,
  } = usePlaybackForegroundSync({
    playbackCursorOrdinalRef,
    playbackRequestHeadersRef,
    playbackRunIdRef,
    playbackSessionRef,
    refreshPlaybackTimeline,
    setPlaybackSeekLayout: setActivePlaybackSeekLayout,
  });
  const onPendingSeekExpired = useCallback(() => {
    if (!isPlayingRef.current) {
      setPlaybackPhase('ready');
      return;
    }
    isPlayingRef.current = false;
    setWorkerPlaybackActive(false);
    stopPlaybackProjectionLoop();
    stopPlaybackForegroundSync();
    playbackInFlightRef.current = false;
    setIsPlaying(false);
    setPlaybackPhase('failed');
    toast.error('Audio was not ready after waiting. Try Play again.', {
      id: 'tts-playback-error',
      duration: 7000,
    });
  }, [
    isPlayingRef,
    setIsPlaying,
    setWorkerPlaybackActive,
    stopPlaybackForegroundSync,
    stopPlaybackProjectionLoop,
  ]);
  const {
    cancelPendingSeek,
    getPendingSeekOrdinal,
    hasPendingSeek,
    seekPlaybackTo,
    seekPlaybackToOrdinal,
    startPendingSeek,
    syncActivePlaybackToOrdinal,
  } = usePlaybackSeek({
    audioRef: unlockedAudioRef,
    audioSpeed,
    isPlayingRef,
    onPendingSeekExpired,
    playbackActiveRef,
    playbackRunIdRef,
    playbackSeekLayout,
    playbackSessionRef,
    projectPlaybackTime,
    publishPlaybackTimeSec,
    refreshPlaybackTimeline,
    setAudioDocumentTime,
    setPlaybackPhase,
    setSelectedOrdinal,
    syncPlaybackLocator,
    updateWorkerPlaybackCursor,
  });

  const stopPlaybackRecovery = useCallback(() => {
    playbackRecoveryRef.current?.stop();
    playbackRecoveryRef.current = null;
  }, []);

  const abortPlaybackRequest = useCallback(() => {
    playbackRequestAbortRef.current?.abort();
    playbackRequestAbortRef.current = null;
  }, []);

  const invalidatePlaybackRun = useCallback(() => {
    playbackRunIdRef.current += 1;
    stopPlaybackRecovery();
    playbackInFlightRef.current = false;
    abortPlaybackRequest();
  }, [abortPlaybackRequest, playbackRunIdRef, stopPlaybackRecovery]);

  const resetPlaybackSession = useCallback((options?: { clearSeekLayout?: boolean }) => {
    stopPlaybackRecovery();
    stopPlaybackForegroundSync();
    playbackActiveRef.current = false;
    playbackSessionRef.current = null;
    playbackRequestHeadersRef.current = null;
    if (options?.clearSeekLayout) {
      latestSeekLayoutRef.current = null;
      setPlaybackSeekLayout(null);
    }
    resetPlaybackProjection();
    setPlaybackPhase('idle');
  }, [resetPlaybackProjection, setPlaybackSeekLayout, stopPlaybackForegroundSync, stopPlaybackRecovery]);

  const abortAudio = useCallback(() => {
    setWorkerPlaybackActive(false);
    invalidatePlaybackRun();
    cancelPendingSeek();
    resetPlaybackSession();
    clearAudioSource();
    setCurrentWordIndex(null);
  }, [
    cancelPendingSeek,
    clearAudioSource,
    invalidatePlaybackRun,
    resetPlaybackSession,
    setWorkerPlaybackActive,
    setCurrentWordIndex,
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
    setPlaybackPhase('ready');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  }, [
    invalidatePlaybackRun,
    isPlayingRef,
    setPlaybackPhase,
    setWorkerPlaybackActive,
    stopPlaybackForegroundSync,
    stopPlaybackProjectionLoop,
    unlockedAudioRef,
  ]);

  const playWorkerPlaybackStream = useCallback(async () => {
    const runId = playbackRunIdRef.current;
    // React may flush the effect that requested this start immediately after
    // the user canceled it. The intent ref changes synchronously, so check it
    // before stale work can put the controls back into a processing state.
    if (!isPlayingRef.current) {
      playbackInFlightRef.current = false;
      return;
    }
    const request = controller.buildPlaybackPlanRequest();
    if (!request) {
      playbackInFlightRef.current = false;
      return;
    }

    resetPlaybackSession({ clearSeekLayout: true });
    setPlaybackPhase('planning');
    clearAudioSource();

    try {
      const plan = controller.getPlaybackPlan();
      if (runId !== playbackRunIdRef.current) return;
      if (!plan?.planId || !plan.planObjectKey) {
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
      if (!session.sessionInstanceId) throw new Error('Prepared TTS playback session was missing its instance identity');

      playbackSessionRef.current = {
        sessionId: session.sessionId,
        sessionInstanceId: session.sessionInstanceId,
        planId: plan.planId,
        audioUrl: session.audioUrl,
        timelineUrl: session.timelineUrl,
      };
      latestSeekLayoutRef.current = null;
      setPlaybackSeekLayout(null);
      playbackRequestHeadersRef.current = headers;
      setPlaybackPhase('ready');

      controller.applyPlaybackPlan(plan);

      const requestedStartOrdinal = Math.max(0, Math.floor(Number(selectedOrdinal)));
      playbackCursorOrdinalRef.current = requestedStartOrdinal;
      await setWorkerPlaybackActive(true, true);
      if (runId !== playbackRunIdRef.current || !isPlayingRef.current) return;
      startPlaybackForegroundSync(runId);

      const initialSeekLayout = await waitForPlaybackStartBuffer({
        sessionId: session.sessionId,
        // Foreground SSE owns seek-layout refreshes. Startup waits on the latest
        // snapshot it has delivered instead of creating a second HTTP poll loop.
        loadLayout: () => Promise.resolve(latestSeekLayoutRef.current),
        isCurrent: () => runId === playbackRunIdRef.current,
        playbackRate: audioSpeed,
      });
      if (runId !== playbackRunIdRef.current || !initialSeekLayout) return;
      setActivePlaybackSeekLayout(initialSeekLayout);
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

      const audio = ensureAudio();
      audio.defaultPlaybackRate = audioSpeed;
      audio.playbackRate = audioSpeed;
      audio.volume = 1;
      const recover = () => { setPlaybackPhase('buffering'); checkRecovery(); };
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
          playbackInFlightRef.current = false; resetPlaybackSession();
          setPlaybackPhase('ended');
          if (isPlayingRef.current) void onAdvance();
        },
        onTime: () => {
          const documentTimeSec = documentTimeForAudio(audio);
          publishPlaybackTimeSec(documentTimeSec, { force: true });
          projectPlaybackTime(documentTimeSec);
        },
        onPlaying: () => {
          setPlaybackPhase('playing'); startPlaybackProjectionLoop(audio, runId);
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
          && !hasPendingSeek(),
        getDocumentTime: () => documentTimeForAudio(audio),
        getOrdinal: () => playbackCursorOrdinalRef.current,
        getLayout: () => latestSeekLayoutRef.current,
        setStreamBase: (seconds) => { playbackStreamBaseSecRef.current = seconds; },
        onBuffering: () => {
          setPlaybackPhase('buffering');
        },
        onExhausted: () => {
          pauseActivePlayback();
          clearAudioSource();
          setIsPlaying(false);
          setPlaybackPhase('failed');
          toast.error('Audio is ready, but playback could not reconnect. Try Play again.', { id: 'tts-playback-error' });
        },
        onTerminalFailure: () => {
          pauseActivePlayback();
          clearAudioSource();
          setIsPlaying(false);
          setPlaybackPhase('failed');
          toast.error('TTS generation stopped before more audio became available. Try Play again.', {
            id: 'tts-playback-error',
            duration: 7000,
          });
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
      resetPlaybackSession();
      setIsPlaying(false);
      setPlaybackPhase('failed');
      toast.error('TTS playback failed. Paused playback.', {
        id: 'tts-playback-error',
        duration: 7000,
      });
    }
  }, [
    audioSpeed,
    clearAudioSource,
    controller,
    checkRecovery,
    documentTimeForAudio,
    ensureAudio,
    hasPendingSeek,
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
    resetPlaybackSession,
    setIsPlaying,
    setPlaybackPhase,
    setActivePlaybackSeekLayout,
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
    playbackRunIdRef,
    checkRecovery,
    setIsPlaying,
    setPlaybackPhase,
    setWorkerPlaybackActive,
    startPlaybackForegroundSync,
  });

  const togglePlay = useCallback(() => {
    if (isPlaying) {
      cancelPendingSeek();
      pauseActivePlayback();
      setIsPlaying(false);
      return;
    }

    const pendingSeekOrdinal = getPendingSeekOrdinal();
    if (pendingSeekOrdinal !== null) {
      unlockAudioOnUserGesture(playbackActiveRef.current);
      setWorkerPlaybackActive(true);
      setPlaybackPhase('buffering');
      isPlayingRef.current = true;
      setIsPlaying(true);
      startPlaybackForegroundSync(playbackRunIdRef.current);
      startPendingSeek(pendingSeekOrdinal);
      return;
    }

    unlockAudioOnUserGesture(playbackActiveRef.current);

    const audio = unlockedAudioRef.current;
    if (audio && playbackActiveRef.current && audio.src) {
      resumeActivePlayback(audio);
      return;
    }

    isPlayingRef.current = true;
    setIsPlaying(true);
  }, [
    cancelPendingSeek,
    getPendingSeekOrdinal,
    isPlaying,
    isPlayingRef,
    pauseActivePlayback,
    playbackRunIdRef,
    resumeActivePlayback,
    setIsPlaying,
    setPlaybackPhase,
    setWorkerPlaybackActive,
    startPendingSeek,
    startPlaybackForegroundSync,
    unlockAudioOnUserGesture,
    unlockedAudioRef,
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

  useEffect(() => () => {
    stopPlaybackRecovery();
    abortPlaybackRequest();
    stopPlaybackForegroundSync();
  }, [abortPlaybackRequest, stopPlaybackForegroundSync, stopPlaybackRecovery]);

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
  }, [documentTimeForAudio, projectPlaybackTime, refreshPlaybackTimeline, unlockedAudioRef]);

  return {
    playbackActiveRef,
    playbackPhase,
    playbackTimeSec,
    abortAudio,
    cancelPendingSeek,
    invalidatePlaybackRun,
    pauseActivePlayback,
    seekPlaybackTo,
    seekPlaybackToOrdinal,
    syncActivePlaybackToOrdinal,
    togglePlay,
  };
}

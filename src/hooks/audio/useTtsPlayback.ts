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
import { restingPlayheadSec } from '@/lib/client/tts/playback-timeline-track';
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
  selectedOrdinal: number | null;
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
    selectedOrdinal,
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
    playbackTimeSec,
    documentTimeForAudio,
    projectPlaybackTime,
    publishPlaybackTimeSec,
    refreshPlaybackTimeline,
    setPlaybackStreamAnchor,
    resetPlaybackProjection,
    seedPlaybackTimeline,
    cancelMediaPosition,
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
    shouldProject: (): boolean => isPlayingRef.current && !hasPendingSeek(),
  });
  useEffect(() => {
    if (isPlaying) return;
    const restingSec = restingPlayheadSec(playbackSeekLayout, selectedOrdinal, playbackTimeSec);
    if (restingSec !== null) publishPlaybackTimeSec(restingSec, { force: true });
  }, [isPlaying, playbackSeekLayout, playbackTimeSec, publishPlaybackTimeSec, selectedOrdinal]);
  const {
    modelDownload,
    setWorkerPlaybackActive,
    startPlaybackForegroundSync,
    stopPlaybackForegroundSync,
    updateWorkerPlaybackCursor,
    refreshPlaybackOverview,
  } = usePlaybackForegroundSync({
    audioRef: unlockedAudioRef,
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
    unlockedAudioRef.current?.pause();
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
    unlockedAudioRef,
  ]);
  const {
    cancelPendingSeek,
    getPendingSeekOrdinal,
    getPendingSeekOffsetSec,
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
    cancelMediaPosition,
    projectPlaybackTime,
    publishPlaybackTimeSec,
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

  const resetPlaybackSession = useCallback((options?: { clearSeekLayout?: boolean; preservePosition?: boolean }) => {
    stopPlaybackRecovery();
    stopPlaybackForegroundSync();
    playbackActiveRef.current = false;
    playbackSessionRef.current = null;
    playbackRequestHeadersRef.current = null;
    if (options?.clearSeekLayout) {
      latestSeekLayoutRef.current = null;
      setPlaybackSeekLayout(null);
    }
    resetPlaybackProjection({ preservePosition: options?.preservePosition });
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
    const startupStartedAt = performance.now();
    const startupTiming = { prepareMs: 0, activateMs: 0, readinessMs: 0 };
    let startupReported = false;
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

    const retainedLayout = latestSeekLayoutRef.current;
    const retainedSlot = retainedLayout?.segments.find((segment) => segment.ordinal === selectedOrdinalRef.current);
    const retainedOffsetSec = retainedSlot?.generated
      ? Math.max(0, Math.min(playbackTimeSec - retainedSlot.startMs / 1000, (retainedSlot.durationMs - 1) / 1000)) : 0;
    const startOffset = () => getPendingSeekOrdinal() !== null ? getPendingSeekOffsetSec() : retainedOffsetSec;
    resetPlaybackSession({ preservePosition: true });
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
      startupTiming.prepareMs = performance.now() - startupStartedAt;

      playbackSessionRef.current = {
        sessionId: session.sessionId,
        sessionInstanceId: session.sessionInstanceId,
        planId: plan.planId,
        audioUrl: session.audioUrl,
        timelineUrl: session.timelineUrl,
      };
      latestSeekLayoutRef.current = null;
      playbackRequestHeadersRef.current = headers;
      setPlaybackPhase('ready');

      controller.applyPlaybackPlan(plan);

      const requestedStartOrdinal = selectedOrdinalRef.current ?? Math.max(0, Math.floor(Number(selectedOrdinal)));
      playbackCursorOrdinalRef.current = requestedStartOrdinal;
      if (retainedLayout) seedPlaybackTimeline(retainedLayout, session.sessionId);
      const activateStartedAt = performance.now();
      await setWorkerPlaybackActive(true, true);
      startupTiming.activateMs = performance.now() - activateStartedAt;
      if (runId !== playbackRunIdRef.current || !isPlayingRef.current) return;
      startPlaybackForegroundSync(runId);
      const readinessStartedAt = performance.now();

      const audio = ensureAudio();
      audio.volume = 1;
      let startOrdinal: number;
      let startOffsetSec: number;
      let initialStartSec: number;
      for (;;) {
        const layout = await waitForPlaybackStartBuffer({
          sessionId: session.sessionId,
          // SSE owns remote reads. Only the latest target can attach media.
          loadLayout: () => Promise.resolve(latestSeekLayoutRef.current),
          isCurrent: () => runId === playbackRunIdRef.current && isPlayingRef.current,
          playbackRate: audioSpeed,
          getStartOrdinal: () => getPendingSeekOrdinal() ?? selectedOrdinalRef.current ?? requestedStartOrdinal,
          getStartOffsetMs: () => startOffset() * 1000,
        });
        if (runId !== playbackRunIdRef.current || !isPlayingRef.current || !layout) return;
        startupTiming.readinessMs = performance.now() - readinessStartedAt;
        setActivePlaybackSeekLayout(layout);
        startOrdinal = getPendingSeekOrdinal() ?? selectedOrdinalRef.current ?? requestedStartOrdinal;
        startOffsetSec = startOffset();
        const slot = layout.segments.find((segment) => segment.ordinal === startOrdinal);
        if (!slot || !playbackSegmentsRef.current.some((segment) => segment.ordinal === startOrdinal)) {
          throw new Error('The playback target is not present in the canonical timeline');
        }
        initialStartSec = Math.max(0, slot.startMs / 1000);
        playbackCursorOrdinalRef.current = startOrdinal;
        const positioned = await setAudioDocumentTime(audio, initialStartSec + startOffsetSec, startOrdinal, initialStartSec, {
          reopenStream: true,
        });
        if (runId !== playbackRunIdRef.current || !isPlayingRef.current) return;
        if (positioned) break;
        // A new seek aborted media positioning. Reconcile it in the same
        // prepared session instead of completing the old start or restarting.
      }
      const recover = () => { setPlaybackPhase('buffering'); checkRecovery(); };
      installPlaybackMediaEvents({ audio,
        isCurrent: () => runId === playbackRunIdRef.current,
        isPlaying: () => isPlayingRef.current,
        shouldRecoverEnd: () => {
          if (hasPendingSeek()) return true;
          const last = latestSeekLayoutRef.current?.segments.at(-1)?.ordinal;
          return last !== undefined && (playbackCursorOrdinalRef.current ?? 0) < last;
        },
        reachedEnd: () => {
          if (!isPlayingRef.current || hasPendingSeek()) return false;
          const last = latestSeekLayoutRef.current?.segments.at(-1);
          if (!last || (!last.generated && last.audioState !== 'error')) return false;
          return documentTimeForAudio(audio) * 1000 >= last.endMs;
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
          if (!isPlayingRef.current || hasPendingSeek()) return;
          const documentTimeSec = documentTimeForAudio(audio);
          publishPlaybackTimeSec(documentTimeSec, { force: true });
          projectPlaybackTime(documentTimeSec);
        },
        onPlaying: () => {
          if (hasPendingSeek()) return;
          if (!startupReported) {
            startupReported = true;
            const totalMs = performance.now() - startupStartedAt;
            console.info('tts.playback.startup', JSON.stringify({
              ...startupTiming, totalMs,
              mediaMs: Math.max(0, totalMs - startupTiming.prepareMs
                - startupTiming.activateMs - startupTiming.readinessMs),
              fromOrdinal: startOrdinal,
            }));
          }
          refreshPlaybackOverview();
          setPlaybackPhase('playing'); startPlaybackProjectionLoop(audio, runId);
        },
      });

      playbackActiveRef.current = true;
      cancelPendingSeek();
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
        setStreamBase: (seconds) => {
          const ordinal = playbackCursorOrdinalRef.current;
          if (ordinal !== null) setPlaybackStreamAnchor(ordinal, seconds);
        },
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
          resetPlaybackSession();
          clearAudioSource();
          setIsPlaying(false);
          setPlaybackPhase('failed');
          toast.error('TTS generation stopped before more audio became available. Try Play again.', {
            id: 'tts-playback-error',
            duration: 7000,
          });
        },
      });
      publishPlaybackTimeSec(initialStartSec + startOffsetSec, { force: true });
      projectPlaybackTime(initialStartSec + startOffsetSec);
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
      cancelPendingSeek();
      resetPlaybackSession({ preservePosition: true });
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
    cancelPendingSeek,
    documentTimeForAudio,
    ensureAudio,
    hasPendingSeek,
    getPendingSeekOrdinal,
    getPendingSeekOffsetSec,
    isPlayingRef,
    onAdvance,
    pauseActivePlayback,
    playbackCursorOrdinalRef,
    playbackRunIdRef,
    playbackSegmentsRef,
    playbackTimeSec,
    projectPlaybackTime,
    publishPlaybackTimeSec,
    refreshPlaybackOverview,
    resetPlaybackSession,
    seedPlaybackTimeline,
    setIsPlaying,
    setPlaybackPhase,
    setActivePlaybackSeekLayout,
    setAudioDocumentTime,
    selectedOrdinalRef,
    setPlaybackStreamAnchor,
    setWorkerPlaybackActive,
    startPlaybackForegroundSync,
    startPlaybackProjectionLoop,
    stopPlaybackProjectionLoop,
  ]);

  const resumeActivePlayback = usePlaybackMediaResume({
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
    if (isPlayingRef.current) {
      cancelPendingSeek();
      pauseActivePlayback();
      setIsPlaying(false);
      return;
    }

    const pendingSeekOrdinal = getPendingSeekOrdinal();
    const audio = unlockedAudioRef.current;
    const ordinal = pendingSeekOrdinal ?? selectedOrdinalRef.current;
    const needsPosition = audio && (playbackPhase === 'failed'
      || Math.abs(documentTimeForAudio(audio) - playbackTimeSec) > 0.5);
    if (ordinal !== null && playbackActiveRef.current && playbackSessionRef.current
      && (pendingSeekOrdinal !== null || needsPosition)) {
      unlockAudioOnUserGesture(playbackActiveRef.current);
      setPlaybackPhase('buffering');
      isPlayingRef.current = true;
      setIsPlaying(true);
      const slot = latestSeekLayoutRef.current?.segments.find((segment) => segment.ordinal === ordinal);
      const offsetSec = pendingSeekOrdinal !== null
        ? getPendingSeekOffsetSec() : Math.max(0, playbackTimeSec - (slot?.startMs ?? playbackTimeSec * 1000) / 1000);
      startPendingSeek(ordinal, offsetSec);
      setWorkerPlaybackActive(true);
      startPlaybackForegroundSync(playbackRunIdRef.current);
      return;
    }

    if (pendingSeekOrdinal !== null) cancelPendingSeek();
    unlockAudioOnUserGesture(playbackActiveRef.current);

    if (audio && playbackActiveRef.current && audio.src) {
      resumeActivePlayback(audio);
      return;
    }

    isPlayingRef.current = true;
    setIsPlaying(true);
  }, [
    cancelPendingSeek,
    getPendingSeekOrdinal,
    getPendingSeekOffsetSec,
    documentTimeForAudio,
    isPlayingRef,
    pauseActivePlayback,
    playbackRunIdRef,
    playbackPhase,
    playbackTimeSec,
    selectedOrdinalRef,
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
    modelDownload,
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

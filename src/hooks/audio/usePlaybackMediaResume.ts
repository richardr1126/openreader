'use client';

import { useCallback, type MutableRefObject } from 'react';

import { resumePlaybackMedia } from '@/lib/client/tts/playback-control';
import type { TTSRequestHeaders } from '@/types/client';
import type { TtsPlaybackPhase } from '@/types/tts';
import type { PlaybackSessionState } from '@/hooks/audio/usePlaybackProjection';

type UsePlaybackMediaResumeInput = {
  audioSpeed: number;
  isPlayingRef: MutableRefObject<boolean>;
  playbackActiveRef: MutableRefObject<boolean>;
  playbackInFlightRef: MutableRefObject<boolean>;
  playbackRequestHeadersRef: MutableRefObject<TTSRequestHeaders | null>;
  playbackResumeRunIdRef: MutableRefObject<number | null>;
  playbackRunIdRef: MutableRefObject<number>;
  playbackSessionRef: MutableRefObject<PlaybackSessionState | null>;
  cancelSeekResync: () => void;
  invalidatePlaybackRun: () => void;
  reconnectPlaybackStream: () => void;
  setIsPlaying: (value: boolean) => void;
  setIsProcessing: (value: boolean) => void;
  setPlaybackPhase: (phase: TtsPlaybackPhase) => void;
  setWorkerPlaybackActive: (active: boolean) => void;
  startPlaybackForegroundSync: (runId: number, headers: TTSRequestHeaders) => void;
  stopPlaybackForegroundSync: () => void;
  stopPlaybackProjectionLoop: () => void;
};

export function usePlaybackMediaResume(input: UsePlaybackMediaResumeInput) {
  const {
    audioSpeed,
    isPlayingRef,
    playbackActiveRef,
    playbackInFlightRef,
    playbackRequestHeadersRef,
    playbackResumeRunIdRef,
    playbackRunIdRef,
    playbackSessionRef,
    cancelSeekResync,
    invalidatePlaybackRun,
    reconnectPlaybackStream,
    setIsPlaying,
    setIsProcessing,
    setPlaybackPhase,
    setWorkerPlaybackActive,
    startPlaybackForegroundSync,
    stopPlaybackForegroundSync,
    stopPlaybackProjectionLoop,
  } = input;

  return useCallback((audio: HTMLAudioElement) => {
    const resumeRunId = playbackRunIdRef.current;
    const headers = playbackRequestHeadersRef.current;
    setWorkerPlaybackActive(true);
    if (headers) startPlaybackForegroundSync(resumeRunId, headers);
    audio.playbackRate = audioSpeed;
    playbackInFlightRef.current = true;
    setPlaybackPhase('buffering');
    setIsProcessing(true);
    isPlayingRef.current = true;
    setIsPlaying(true);
    playbackResumeRunIdRef.current = resumeRunId;

    void resumePlaybackMedia(
      () => audio.play(),
      () => resumeRunId === playbackRunIdRef.current && isPlayingRef.current,
    ).then((result) => {
      if (playbackResumeRunIdRef.current === resumeRunId) {
        playbackResumeRunIdRef.current = null;
      }
      if (result.status !== 'stale') return;

      console.warn('TTS media stream became stale; reconnecting from the current cursor:', result.error);
      setWorkerPlaybackActive(false);
      invalidatePlaybackRun();
      cancelSeekResync();
      stopPlaybackProjectionLoop();
      stopPlaybackForegroundSync();
      playbackActiveRef.current = false;
      playbackSessionRef.current = null;
      playbackRequestHeadersRef.current = null;
      try {
        audio.onerror = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch {
        // A replacement stream does not depend on stale media teardown.
      }
      playbackInFlightRef.current = true;
      setPlaybackPhase('planning');
      setIsProcessing(true);
      reconnectPlaybackStream();
    });
  }, [
    audioSpeed,
    cancelSeekResync,
    invalidatePlaybackRun,
    isPlayingRef,
    playbackActiveRef,
    playbackInFlightRef,
    playbackRequestHeadersRef,
    playbackResumeRunIdRef,
    playbackRunIdRef,
    playbackSessionRef,
    reconnectPlaybackStream,
    setIsPlaying,
    setIsProcessing,
    setPlaybackPhase,
    setWorkerPlaybackActive,
    startPlaybackForegroundSync,
    stopPlaybackForegroundSync,
    stopPlaybackProjectionLoop,
  ]);
}

'use client';

import { useCallback, type MutableRefObject } from 'react';
import { resumePlaybackMedia } from '@/lib/client/tts/playback-control';
import type { TTSRequestHeaders } from '@/types/client';
import type { TtsPlaybackPhase } from '@/types/tts';

export function usePlaybackMediaResume(input: {
  audioSpeed: number;
  isPlayingRef: MutableRefObject<boolean>;
  playbackInFlightRef: MutableRefObject<boolean>;
  playbackRequestHeadersRef: MutableRefObject<TTSRequestHeaders | null>;
  playbackRunIdRef: MutableRefObject<number>;
  setIsPlaying: (value: boolean) => void;
  setIsProcessing: (value: boolean) => void;
  setPlaybackPhase: (phase: TtsPlaybackPhase) => void;
  setWorkerPlaybackActive: (active: boolean) => void;
  startPlaybackForegroundSync: (runId: number, headers: TTSRequestHeaders) => void;
  checkRecovery: () => void;
}) {
  const {
    audioSpeed, isPlayingRef, playbackInFlightRef, playbackRequestHeadersRef,
    playbackRunIdRef, setIsPlaying, setIsProcessing, setPlaybackPhase,
    setWorkerPlaybackActive, startPlaybackForegroundSync, checkRecovery,
  } = input;
  return useCallback((audio: HTMLAudioElement) => {
    const runId = playbackRunIdRef.current;
    setWorkerPlaybackActive(true);
    const headers = playbackRequestHeadersRef.current;
    if (headers) startPlaybackForegroundSync(runId, headers);
    audio.playbackRate = audioSpeed;
    playbackInFlightRef.current = true;
    setPlaybackPhase('buffering');
    setIsProcessing(true);
    isPlayingRef.current = true;
    setIsPlaying(true);
    // Recovery also watches play() promises that never settle. Neither path
    // replaces the playback session or discards the generated-cache timeline.
    void resumePlaybackMedia(() => audio.play(), () => (
      runId === playbackRunIdRef.current && isPlayingRef.current
    )).then((result) => { if (result.status === 'stale') checkRecovery(); });
  }, [
    audioSpeed, isPlayingRef, playbackInFlightRef, playbackRequestHeadersRef,
    playbackRunIdRef, setIsPlaying, setIsProcessing, setPlaybackPhase,
    setWorkerPlaybackActive, startPlaybackForegroundSync, checkRecovery,
  ]);
}

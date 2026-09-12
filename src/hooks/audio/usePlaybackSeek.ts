'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

import type { TtsPlaybackSeekLayout } from '@/lib/client/api/tts';
import { isPlaybackStartBufferReady } from '@/lib/client/tts/playback-control';
import type { PlaybackSessionState } from '@/hooks/audio/usePlaybackProjection';
import type { TTSSegmentLocator } from '@/types/client';
import type { TtsPlaybackPhase } from '@/types/tts';

type PendingSeek = {
  ordinal: number;
  runId: number;
  expiresAt: number;
};

type UsePlaybackSeekInput = {
  audioRef: MutableRefObject<HTMLAudioElement | null>;
  audioSpeed: number;
  isPlayingRef: MutableRefObject<boolean>;
  onPendingSeekExpired: () => void;
  playbackActiveRef: MutableRefObject<boolean>;
  playbackRunIdRef: MutableRefObject<number>;
  playbackSeekLayout: TtsPlaybackSeekLayout | null;
  playbackSessionRef: MutableRefObject<PlaybackSessionState | null>;
  projectPlaybackTime: (seconds: number) => void;
  publishPlaybackTimeSec: (seconds: number, options?: { force?: boolean }) => void;
  refreshPlaybackTimeline: (timelineUrl: string, signal?: AbortSignal) => Promise<unknown>;
  setAudioDocumentTime: (
    audio: HTMLAudioElement,
    documentTimeSec: number,
    targetOrdinal: number,
    targetStartSec: number,
    options?: { reopenStream?: boolean },
  ) => void;
  setPlaybackPhase: (phase: TtsPlaybackPhase) => void;
  setSelectedOrdinal: (ordinal: number | null) => void;
  syncPlaybackLocator?: (locator: TTSSegmentLocator | null) => void;
  updateWorkerPlaybackCursor: (ordinal: number) => void;
};

export function usePlaybackSeek(input: UsePlaybackSeekInput) {
  const {
    audioRef,
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
  } = input;
  const [pendingSeek, setPendingSeekState] = useState<PendingSeek | null>(null);
  const pendingSeekRef = useRef<PendingSeek | null>(null);

  const setPendingSeek = useCallback((next: PendingSeek | null) => {
    pendingSeekRef.current = next;
    setPendingSeekState(next);
  }, []);

  const cancelPendingSeek = useCallback(() => setPendingSeek(null), [setPendingSeek]);

  const applyReadyMediaPosition = useCallback((
    documentTimeSec: number,
    ordinal: number,
    segmentStartSec: number,
    reopenStream = false,
  ) => {
    const audio = audioRef.current;
    if (!audio || !playbackActiveRef.current || !audio.src) return;
    try {
      setAudioDocumentTime(audio, documentTimeSec, ordinal, segmentStartSec, { reopenStream });
    } catch {
      // Projection still updates even when a browser rejects the media seek.
    }
    if (isPlayingRef.current) {
      audio.playbackRate = audioSpeed;
      void audio.play().catch(() => undefined);
      setPlaybackPhase('playing');
    } else {
      setPlaybackPhase('ready');
    }
  }, [
    audioRef,
    audioSpeed,
    isPlayingRef,
    playbackActiveRef,
    setAudioDocumentTime,
    setPlaybackPhase,
  ]);

  const startPendingSeek = useCallback((ordinal: number) => {
    const normalizedOrdinal = Math.max(0, Math.floor(ordinal));
    setPendingSeek({
      ordinal: normalizedOrdinal,
      runId: playbackRunIdRef.current,
      expiresAt: Date.now() + 60_000,
    });
    setPlaybackPhase('buffering');
    updateWorkerPlaybackCursor(normalizedOrdinal);
  }, [playbackRunIdRef, setPendingSeek, setPlaybackPhase, updateWorkerPlaybackCursor]);

  useEffect(() => {
    if (!pendingSeek) return undefined;
    const delay = Math.max(0, pendingSeek.expiresAt - Date.now());
    const timeout = setTimeout(() => {
      if (pendingSeekRef.current !== pendingSeek) return;
      setPendingSeek(null);
      onPendingSeekExpired();
    }, delay);
    return () => clearTimeout(timeout);
  }, [onPendingSeekExpired, pendingSeek, setPendingSeek]);

  useEffect(() => {
    if (!pendingSeek) return undefined;
    if (pendingSeek.runId !== playbackRunIdRef.current) {
      setPendingSeek(null);
      return undefined;
    }
    const layout = playbackSeekLayout;
    const slot = layout?.segments.find((segment) => segment.ordinal === pendingSeek.ordinal);
    if (!layout || !slot?.generated || !isPlaybackStartBufferReady({
      segments: layout.segments,
      startOrdinal: pendingSeek.ordinal,
      playbackRate: audioSpeed,
    })) return undefined;

    const session = playbackSessionRef.current;
    if (!session) return undefined;
    let current = true;
    void refreshPlaybackTimeline(session.timelineUrl)
      .catch(() => undefined)
      .then(() => {
        if (!current || pendingSeekRef.current !== pendingSeek
          || pendingSeek.runId !== playbackRunIdRef.current
          || playbackSessionRef.current !== session) return;
        const targetSec = Math.max(0, slot.startMs / 1000);
        setSelectedOrdinal(pendingSeek.ordinal);
        // A generated range after a gap cannot be read through the old stream
        // prefix. Reopen only after SSE proves the target buffer is ready.
        applyReadyMediaPosition(targetSec, pendingSeek.ordinal, targetSec, true);
        publishPlaybackTimeSec(targetSec, { force: true });
        projectPlaybackTime(targetSec);
        setPendingSeek(null);
      });
    return () => { current = false; };
  }, [
    applyReadyMediaPosition,
    audioSpeed,
    pendingSeek,
    playbackRunIdRef,
    playbackSeekLayout,
    playbackSessionRef,
    projectPlaybackTime,
    publishPlaybackTimeSec,
    refreshPlaybackTimeline,
    setPendingSeek,
    setSelectedOrdinal,
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
      syncPlaybackLocator?.(target.locator as TTSSegmentLocator);
    }

    const audio = audioRef.current;
    const hasReadyBuffer = target.generated && isPlaybackStartBufferReady({
      segments: layout.segments,
      startOrdinal: target.ordinal,
      playbackRate: audioSpeed,
      offsetWithinStartSegmentMs: Math.max(0, targetMs - target.startMs),
    });

    if (hasReadyBuffer) {
      cancelPendingSeek();
      updateWorkerPlaybackCursor(target.ordinal);
      applyReadyMediaPosition(targetSec, target.ordinal, targetStartSec);
      projectPlaybackTime(targetSec);
      return;
    }

    if (isPlayingRef.current && audio) {
      try {
        audio.pause();
      } catch {
        // Ignore media pause errors while changing the stream range.
      }
      setPlaybackPhase('buffering');
    }
    // Do not seek the media element into an ungenerated range. WebKit retries
    // a 409 response aggressively; the pending-seek effect reopens the stream
    // after the SSE read model proves contiguous target audio is ready.
    projectPlaybackTime(targetStartSec);
    startPendingSeek(target.ordinal);
  }, [
    audioRef,
    audioSpeed,
    applyReadyMediaPosition,
    cancelPendingSeek,
    isPlayingRef,
    playbackSeekLayout,
    projectPlaybackTime,
    publishPlaybackTimeSec,
    setPlaybackPhase,
    setSelectedOrdinal,
    startPendingSeek,
    syncPlaybackLocator,
    updateWorkerPlaybackCursor,
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
  }, [playbackActiveRef, playbackSessionRef, seekPlaybackToOrdinal]);

  const getPendingSeekOrdinal = useCallback(() => pendingSeekRef.current?.ordinal ?? null, []);
  const hasPendingSeek = useCallback(() => pendingSeekRef.current !== null, []);

  useEffect(() => () => { pendingSeekRef.current = null; }, []);

  return {
    cancelPendingSeek,
    getPendingSeekOrdinal,
    hasPendingSeek,
    seekPlaybackTo,
    seekPlaybackToOrdinal,
    startPendingSeek,
    syncActivePlaybackToOrdinal,
  };
}

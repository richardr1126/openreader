'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

import type { TtsPlaybackSeekLayout } from '@/lib/client/api/tts';
import { createPlaybackReadinessDeadline, isPlaybackStartBufferReady } from '@/lib/client/tts/playback-control';
import type { PlaybackSessionState } from '@/hooks/audio/usePlaybackProjection';
import { isPlaybackSlotPlayable } from '@openreader/tts/playback-buffer';
import type { TTSSegmentLocator } from '@/types/client';
import type { TtsPlaybackPhase } from '@/types/tts';

type PendingSeek = {
  ordinal: number;
  offsetSec: number;
  reopenStream: boolean;
  runId: number;
  remainingWait: ReturnType<typeof createPlaybackReadinessDeadline>;
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
  cancelMediaPosition: () => void;
  projectPlaybackTime: (seconds: number) => void;
  publishPlaybackTimeSec: (seconds: number, options?: { force?: boolean }) => void;
  setAudioDocumentTime: (
    audio: HTMLAudioElement,
    documentTimeSec: number,
    targetOrdinal: number,
    targetStartSec: number,
    options?: { reopenStream?: boolean },
  ) => Promise<boolean>;
  setPlaybackPhase: (phase: TtsPlaybackPhase) => void;
  setSelectedOrdinal: (ordinal: number | null) => void;
  syncPlaybackLocator?: (locator: TTSSegmentLocator | null) => void;
  updateWorkerPlaybackCursor: (ordinal: number) => void;
};

export function usePlaybackSeek(input: UsePlaybackSeekInput) {
  const {
    audioRef, audioSpeed, isPlayingRef, onPendingSeekExpired, playbackActiveRef,
    playbackRunIdRef, playbackSeekLayout, playbackSessionRef, cancelMediaPosition,
    projectPlaybackTime, publishPlaybackTimeSec, setAudioDocumentTime,
    setPlaybackPhase, setSelectedOrdinal, syncPlaybackLocator, updateWorkerPlaybackCursor,
  } = input;
  const [pendingSeek, setPendingSeekState] = useState<PendingSeek | null>(null);
  const pendingSeekRef = useRef<PendingSeek | null>(null);
  const latestLayoutRef = useRef(playbackSeekLayout);
  latestLayoutRef.current = playbackSeekLayout;
  const applyingSeekRef = useRef<PendingSeek | null>(null);
  const seekSequenceRef = useRef(0);

  const setPendingSeek = useCallback((next: PendingSeek | null) => {
    seekSequenceRef.current += 1;
    cancelMediaPosition();
    pendingSeekRef.current = next;
    setPendingSeekState(next);
  }, [cancelMediaPosition]);
  const cancelPendingSeek = useCallback(() => setPendingSeek(null), [setPendingSeek]);

  const startPendingSeek = useCallback((ordinal: number, offsetSec = 0, reopenStream = true) => {
    const normalizedOrdinal = Math.max(0, Math.floor(ordinal));
    setPendingSeek({
      ordinal: normalizedOrdinal, offsetSec, reopenStream,
      runId: playbackRunIdRef.current, remainingWait: createPlaybackReadinessDeadline(),
    });
    setPlaybackPhase('buffering');
    updateWorkerPlaybackCursor(normalizedOrdinal);
  }, [playbackRunIdRef, setPendingSeek, setPlaybackPhase, updateWorkerPlaybackCursor]);

  useEffect(() => {
    // Startup owns preparation, runway readiness, and initial positioning.
    // Its target can change before media exists; a second seek deadline must
    // not consume that readiness budget while preparation is still running.
    if (!pendingSeek || !playbackActiveRef.current) return undefined;
    const segments = playbackSeekLayout?.segments ?? [];
    // Once cached audio is ready, browser positioning owns its own deadline.
    if (isPlaybackStartBufferReady({
      segments, startOrdinal: pendingSeek.ordinal, playbackRate: audioSpeed,
      offsetWithinStartSegmentMs: pendingSeek.offsetSec * 1000,
    })) return undefined;
    const remainingMs = pendingSeek.remainingWait(pendingSeek.ordinal, pendingSeek.offsetSec * 1000, segments);
    const timeout = setTimeout(() => {
      if (pendingSeekRef.current !== pendingSeek) return;
      setPendingSeek(null);
      onPendingSeekExpired();
    }, remainingMs);
    return () => clearTimeout(timeout);
  }, [audioSpeed, onPendingSeekExpired, pendingSeek, playbackActiveRef, playbackSeekLayout, setPendingSeek]);

  useEffect(() => {
    if (!pendingSeek || applyingSeekRef.current === pendingSeek) return;
    if (pendingSeek.runId !== playbackRunIdRef.current) {
      setPendingSeek(null);
      return;
    }
    const layout = playbackSeekLayout;
    const slot = layout?.segments.find((segment) => segment.ordinal === pendingSeek.ordinal);
    if (layout?.status === 'failed') {
      setPendingSeek(null);
      onPendingSeekExpired();
      return;
    }
    const audio = audioRef.current;
    if (!audio || !playbackActiveRef.current || !playbackSessionRef.current
      || !layout || !slot || !isPlaybackSlotPlayable(slot) || !isPlaybackStartBufferReady({
        segments: layout.segments, startOrdinal: pendingSeek.ordinal,
        playbackRate: audioSpeed, offsetWithinStartSegmentMs: pendingSeek.offsetSec * 1000,
      })) return;

    applyingSeekRef.current = pendingSeek;
    const startSec = slot.startMs / 1000;
    const targetSec = startSec + pendingSeek.offsetSec;
    void (async () => {
      try {
        const positioned = await setAudioDocumentTime(audio, targetSec, pendingSeek.ordinal, startSec, {
          reopenStream: pendingSeek.reopenStream || Boolean(audio.error) || !audio.src,
        });
        if (!positioned || pendingSeekRef.current !== pendingSeek) return;
        setPendingSeek(null);
        const sequence = seekSequenceRef.current;
        const currentSlot = latestLayoutRef.current?.segments.find((segment) => segment.ordinal === pendingSeek.ordinal);
        const currentTargetSec = (currentSlot?.startMs ?? slot.startMs) / 1000 + pendingSeek.offsetSec;
        publishPlaybackTimeSec(currentTargetSec, { force: true });
        projectPlaybackTime(currentTargetSec);
        if (!isPlayingRef.current) {
          setPlaybackPhase('ready');
          return;
        }
        setPlaybackPhase('buffering');
        // A later seek or pause owns both the position and any play() rejection.
        void audio.play().catch(() => {
          if (seekSequenceRef.current === sequence && isPlayingRef.current) onPendingSeekExpired();
        });
      } catch {
        if (pendingSeekRef.current !== pendingSeek) return;
        setPendingSeek(null);
        onPendingSeekExpired();
      } finally {
        if (applyingSeekRef.current === pendingSeek) applyingSeekRef.current = null;
      }
    })();
  }, [
    audioRef, audioSpeed, isPlayingRef, onPendingSeekExpired, pendingSeek,
    playbackActiveRef, playbackRunIdRef, playbackSeekLayout, playbackSessionRef,
    projectPlaybackTime, publishPlaybackTimeSec, setAudioDocumentTime, setPendingSeek, setPlaybackPhase,
  ]);

  const seekPlaybackTo = useCallback((seconds: number) => {
    const layout = playbackSeekLayout;
    if (!layout?.segments.length || !Number.isFinite(seconds)) return;
    const targetSec = Math.max(0, Math.min(seconds, layout.durationMs / 1000));
    const targetMs = targetSec * 1000;
    const target = layout.segments.find((segment) => targetMs >= segment.startMs && targetMs < segment.endMs)
      ?? layout.segments[layout.segments.length - 1];
    const startSec = target.startMs / 1000;
    const offsetSec = target.generated
      ? Math.max(0, Math.min(targetSec - startSec, (target.durationMs - 1) / 1000)) : 0;
    setSelectedOrdinal(target.ordinal);
    publishPlaybackTimeSec(startSec + offsetSec, { force: true });
    syncPlaybackLocator?.(target.locator);

    if (!playbackActiveRef.current && !isPlayingRef.current) {
      // Idle scrubbing selects a sentence; it never starts a media wait or generation.
      cancelPendingSeek();
      setPlaybackPhase('ready');
      return;
    }
    if (isPlayingRef.current && playbackActiveRef.current) audioRef.current?.pause();
    startPendingSeek(target.ordinal, offsetSec, !target.generated);
  }, [
    audioRef, cancelPendingSeek, isPlayingRef, playbackActiveRef, playbackSeekLayout,
    publishPlaybackTimeSec, setPlaybackPhase, setSelectedOrdinal, startPendingSeek, syncPlaybackLocator,
  ]);

  const seekPlaybackToOrdinal = useCallback((ordinal: number): boolean => {
    if (!Number.isFinite(ordinal)) return false;
    const target = playbackSeekLayout?.segments.find((entry) => entry.ordinal === Math.max(0, Math.floor(ordinal)));
    if (!target) return false;
    seekPlaybackTo(target.startMs / 1000);
    return true;
  }, [playbackSeekLayout, seekPlaybackTo]);

  const syncActivePlaybackToOrdinal = useCallback((ordinal: number): boolean => {
    if (!playbackActiveRef.current && !isPlayingRef.current) return false;
    return seekPlaybackToOrdinal(ordinal);
  }, [isPlayingRef, playbackActiveRef, seekPlaybackToOrdinal]);
  const getPendingSeekOrdinal = useCallback(() => pendingSeekRef.current?.ordinal ?? null, []);
  const getPendingSeekOffsetSec = useCallback(() => pendingSeekRef.current?.offsetSec ?? 0, []);
  const hasPendingSeek = useCallback(() => pendingSeekRef.current !== null, []);

  useEffect(() => () => {
    pendingSeekRef.current = null;
    cancelMediaPosition();
  }, [cancelMediaPosition]);

  return {
    cancelPendingSeek, getPendingSeekOrdinal, getPendingSeekOffsetSec, hasPendingSeek,
    seekPlaybackTo, seekPlaybackToOrdinal, startPendingSeek, syncActivePlaybackToOrdinal,
  };
}

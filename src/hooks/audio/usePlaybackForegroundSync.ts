'use client';

import { useCallback, useRef, type MutableRefObject } from 'react';

import {
  getTtsPlaybackSeekLayout,
  postTtsPlaybackCursor,
  subscribeTtsPlaybackEvents,
  type TtsPlaybackSeekLayout,
} from '@/lib/client/api/tts';
import type { TTSRequestHeaders } from '@/types/client';
import { TTS_PLAYBACK_CURSOR_HEARTBEAT_MS } from '@/types/tts';
import type { PlaybackSessionState } from '@/hooks/audio/usePlaybackProjection';

type UsePlaybackForegroundSyncInput = {
  playbackCursorOrdinalRef: MutableRefObject<number | null>;
  playbackRunIdRef: MutableRefObject<number>;
  playbackSessionRef: MutableRefObject<PlaybackSessionState | null>;
  refreshPlaybackTimeline: (timelineUrl: string, signal?: AbortSignal) => Promise<unknown>;
  setPlaybackSeekLayout: (layout: TtsPlaybackSeekLayout | null) => void;
};

export function usePlaybackForegroundSync(input: UsePlaybackForegroundSyncInput) {
  const {
    playbackCursorOrdinalRef,
    playbackRunIdRef,
    playbackSessionRef,
    refreshPlaybackTimeline,
    setPlaybackSeekLayout,
  } = input;
  const playbackEventsUnsubRef = useRef<(() => void) | null>(null);
  const playbackCursorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPlaybackForegroundSync = useCallback(() => {
    if (playbackCursorIntervalRef.current) {
      clearInterval(playbackCursorIntervalRef.current);
      playbackCursorIntervalRef.current = null;
    }
    if (playbackEventsUnsubRef.current) {
      try {
        playbackEventsUnsubRef.current();
      } catch {
        // Ignore teardown errors.
      }
      playbackEventsUnsubRef.current = null;
    }
  }, []);

  const startPlaybackForegroundSync = useCallback((runId: number, headers: TTSRequestHeaders) => {
    const activeSession = playbackSessionRef.current;
    if (!activeSession) return;

    stopPlaybackForegroundSync();
    void refreshPlaybackTimeline(activeSession.timelineUrl).catch(() => undefined);
    playbackEventsUnsubRef.current = subscribeTtsPlaybackEvents(activeSession.sessionId, {
      onSnapshot: (snapshot) => {
        if (runId !== playbackRunIdRef.current || snapshot.status === 'failed') return;
        const currentSession = playbackSessionRef.current;
        if (!currentSession) return;
        void refreshPlaybackTimeline(currentSession.timelineUrl).catch(() => undefined);
        if (currentSession.seekLayoutUrl) {
          void getTtsPlaybackSeekLayout(currentSession.seekLayoutUrl)
            .then((layout) => {
              if (runId === playbackRunIdRef.current) setPlaybackSeekLayout(layout);
            })
            .catch(() => undefined);
        }
      },
    });

    const writeCursor = () => {
      const currentSession = playbackSessionRef.current;
      if (!currentSession) return;
      const cursorOrdinal = playbackCursorOrdinalRef.current;
      if (cursorOrdinal == null) return;
      const cursor = Math.max(0, cursorOrdinal);
      void postTtsPlaybackCursor(currentSession.sessionId, cursor, headers);
    };
    writeCursor();
    playbackCursorIntervalRef.current = setInterval(() => {
      if (runId === playbackRunIdRef.current) writeCursor();
    }, TTS_PLAYBACK_CURSOR_HEARTBEAT_MS);
  }, [
    playbackCursorOrdinalRef,
    playbackRunIdRef,
    playbackSessionRef,
    refreshPlaybackTimeline,
    setPlaybackSeekLayout,
    stopPlaybackForegroundSync,
  ]);

  return { startPlaybackForegroundSync, stopPlaybackForegroundSync };
}

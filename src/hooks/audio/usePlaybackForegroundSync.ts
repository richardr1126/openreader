'use client';

import { useCallback, useRef, type MutableRefObject } from 'react';
import toast from 'react-hot-toast';

import {
  getTtsPlaybackSeekLayout,
  postTtsPlaybackCursor,
  subscribeTtsPlaybackEvents,
  type TtsPlaybackSeekLayout,
  type TtsPlaybackEventSnapshot,
} from '@/lib/client/api/tts';
import type { TTSRequestHeaders } from '@/types/client';
import { TTS_PLAYBACK_CURSOR_HEARTBEAT_MS } from '@/types/tts';
import type { PlaybackSessionState } from '@/hooks/audio/usePlaybackProjection';
import { createCoalescedPlaybackRefresh, createPlaybackOperationSubscription } from '@/lib/client/tts/playback-refresh';

type UsePlaybackForegroundSyncInput = {
  playbackCursorOrdinalRef: MutableRefObject<number | null>;
  playbackRequestHeadersRef: MutableRefObject<TTSRequestHeaders | null>;
  playbackRunIdRef: MutableRefObject<number>;
  playbackSessionRef: MutableRefObject<PlaybackSessionState | null>;
  refreshPlaybackTimeline: (timelineUrl: string, signal?: AbortSignal) => Promise<unknown>;
  setPlaybackSeekLayout: (layout: TtsPlaybackSeekLayout | null) => void;
};

const MODEL_DOWNLOAD_TOAST_ID = 'tts-model-download';

export function usePlaybackForegroundSync(input: UsePlaybackForegroundSyncInput) {
  const {
    playbackCursorOrdinalRef,
    playbackRequestHeadersRef,
    playbackRunIdRef,
    playbackSessionRef,
    refreshPlaybackTimeline,
    setPlaybackSeekLayout,
  } = input;
  const playbackEventsUnsubRef = useRef<(() => void) | null>(null);
  const playbackCursorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playbackActivityWriteRef = useRef<Promise<void>>(Promise.resolve());
  const playbackRefreshRef = useRef<ReturnType<typeof createCoalescedPlaybackRefresh> | null>(null);

  const setWorkerPlaybackActive = useCallback((playbackActive: boolean, requireAcknowledgement = false) => {
    const session = playbackSessionRef.current;
    const headers = playbackRequestHeadersRef.current;
    const ordinal = playbackCursorOrdinalRef.current;
    if (!session || !headers || ordinal == null) return Promise.resolve();
    // Serialize fast pause/resume writes so stale intent cannot arrive last.
    const write = playbackActivityWriteRef.current.then(async () => {
      await postTtsPlaybackCursor(session.sessionId, Math.max(0, ordinal), headers, {
        playbackActive,
        sessionInstanceId: session.sessionInstanceId,
        requireAcknowledgement,
        keepalive: !playbackActive,
      });
    });
    playbackActivityWriteRef.current = write.catch(() => undefined);
    return write;
  }, [playbackCursorOrdinalRef, playbackRequestHeadersRef, playbackSessionRef]);

  const stopPlaybackForegroundSync = useCallback(() => {
    toast.dismiss(MODEL_DOWNLOAD_TOAST_ID);
    playbackRefreshRef.current?.stop();
    playbackRefreshRef.current = null;
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
    const refresh = createCoalescedPlaybackRefresh(async (signal) => {
      if (runId !== playbackRunIdRef.current || playbackSessionRef.current !== activeSession) return;
      const readSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      await Promise.allSettled([
        refreshPlaybackTimeline(activeSession.timelineUrl, readSignal),
        activeSession.seekLayoutUrl
          ? getTtsPlaybackSeekLayout(activeSession.seekLayoutUrl, readSignal).then((layout) => {
            if (!readSignal.aborted && runId === playbackRunIdRef.current
              && playbackSessionRef.current === activeSession) setPlaybackSeekLayout(layout);
          })
          : Promise.resolve(),
      ]);
    });
    playbackRefreshRef.current = refresh;
    refresh.request();
    const events = createPlaybackOperationSubscription<TtsPlaybackEventSnapshot>({
      subscribe: (operationId, onSnapshot) => subscribeTtsPlaybackEvents(activeSession.sessionId, { onSnapshot }, operationId),
      onSnapshot: (snapshot) => {
        if (runId !== playbackRunIdRef.current) return;
        if (snapshot.status === 'failed') {
          toast.dismiss(MODEL_DOWNLOAD_TOAST_ID);
          return;
        }
        if (snapshot.phase === 'downloading_model') {
          const percent = snapshot.totalBytes && snapshot.downloadedBytes !== null
            ? Math.round((snapshot.downloadedBytes / snapshot.totalBytes) * 100)
            : null;
          toast.loading(
            percent === null
              ? 'Downloading word-timing model…'
              : `Downloading word-timing model… ${percent}%`,
            { id: MODEL_DOWNLOAD_TOAST_ID },
          );
          // Audio is already available with proportional timing. Download-only
          // progress does not change either playback read model, so avoid two
          // redundant HTTP reads for every model checkpoint.
          return;
        }
        toast.dismiss(MODEL_DOWNLOAD_TOAST_ID);
        refresh.request();
      },
    });
    playbackEventsUnsubRef.current = events.stop;

    let writingCursor = false;
    const writeCursor = async () => {
      if (writingCursor) return;
      const currentSession = playbackSessionRef.current;
      if (!currentSession) return;
      const cursorOrdinal = playbackCursorOrdinalRef.current;
      if (cursorOrdinal == null) return;
      const cursor = Math.max(0, cursorOrdinal);
      writingCursor = true;
      try {
        const updated = await postTtsPlaybackCursor(currentSession.sessionId, cursor, headers, {
          sessionInstanceId: currentSession.sessionInstanceId,
        });
        if (updated && runId === playbackRunIdRef.current && playbackSessionRef.current === activeSession) {
          events.update(updated.workerOpId);
        }
      } finally {
        writingCursor = false;
      }
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

  return { setWorkerPlaybackActive, startPlaybackForegroundSync, stopPlaybackForegroundSync };
}

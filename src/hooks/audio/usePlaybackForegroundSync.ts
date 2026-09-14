'use client';

import { useCallback, useRef, type MutableRefObject } from 'react';
import toast from 'react-hot-toast';

import {
  postTtsPlaybackCursor,
  subscribeTtsPlaybackEvents,
  type TtsPlaybackSeekLayout,
  type TtsPlaybackEventSnapshot,
} from '@/lib/client/api/tts';
import type { TTSRequestHeaders } from '@/types/client';
import { TTS_PLAYBACK_CURSOR_HEARTBEAT_MS } from '@/types/tts';
import type { PlaybackSessionState } from '@/hooks/audio/usePlaybackProjection';
import { createCoalescedPlaybackRefresh, createPlaybackOperationSubscription } from '@/lib/client/tts/playback-refresh';
import type { TtsPlaybackGrid } from '@/lib/client/tts/playback-grid';
import { useAuthRateLimit } from '@/contexts/AuthRateLimitContext';

type UsePlaybackForegroundSyncInput = {
  playbackCursorOrdinalRef: MutableRefObject<number | null>;
  playbackRequestHeadersRef: MutableRefObject<TTSRequestHeaders | null>;
  playbackRunIdRef: MutableRefObject<number>;
  playbackSessionRef: MutableRefObject<PlaybackSessionState | null>;
  refreshPlaybackTimeline: (timelineUrl: string, signal?: AbortSignal) => Promise<TtsPlaybackGrid>;
  setPlaybackSeekLayout: (layout: TtsPlaybackSeekLayout | null) => void;
};

type PlaybackOperationSubscription = {
  update: (operationId: string | null) => void;
  stop: () => void;
};

const MODEL_DOWNLOAD_TOAST_ID = 'tts-model-download';

export function usePlaybackForegroundSync(input: UsePlaybackForegroundSyncInput) {
  const { refresh: refreshComputeUsage } = useAuthRateLimit();
  const {
    playbackCursorOrdinalRef,
    playbackRequestHeadersRef,
    playbackRunIdRef,
    playbackSessionRef,
    refreshPlaybackTimeline,
    setPlaybackSeekLayout,
  } = input;
  const playbackEventsRef = useRef<PlaybackOperationSubscription | null>(null);
  const playbackCursorIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const playbackActivityWriteRef = useRef<Promise<void>>(Promise.resolve());
  const playbackRefreshRef = useRef<ReturnType<typeof createCoalescedPlaybackRefresh> | null>(null);
  const playbackCursorWriteRef = useRef(false);
  const pendingCursorOrdinalRef = useRef<number | null>(null);
  const usageLimitRefreshRunRef = useRef<number | null>(null);

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

  const updateWorkerPlaybackCursor = useCallback((ordinal?: number) => {
    const requestedOrdinal = ordinal ?? playbackCursorOrdinalRef.current;
    if (requestedOrdinal == null || !Number.isFinite(requestedOrdinal)) return;
    const cursor = Math.max(0, Math.floor(requestedOrdinal));
    playbackCursorOrdinalRef.current = cursor;
    pendingCursorOrdinalRef.current = cursor;
    if (playbackCursorWriteRef.current) return;

    playbackCursorWriteRef.current = true;
    void (async () => {
      try {
        while (pendingCursorOrdinalRef.current !== null) {
          const nextOrdinal = pendingCursorOrdinalRef.current;
          pendingCursorOrdinalRef.current = null;
          const session = playbackSessionRef.current;
          const headers = playbackRequestHeadersRef.current;
          const runId = playbackRunIdRef.current;
          const events = playbackEventsRef.current;
          if (!session || !headers) continue;
          const updated = await postTtsPlaybackCursor(session.sessionId, nextOrdinal, headers, {
            sessionInstanceId: session.sessionInstanceId,
          }).catch(() => null);
          if (updated && runId === playbackRunIdRef.current
            && playbackSessionRef.current === session
            && playbackEventsRef.current === events) {
            events?.update(updated.workerOpId);
          }
        }
      } finally {
        playbackCursorWriteRef.current = false;
      }
    })();
  }, [
    playbackCursorOrdinalRef,
    playbackRequestHeadersRef,
    playbackRunIdRef,
    playbackSessionRef,
  ]);

  const stopPlaybackForegroundSync = useCallback(() => {
    toast.dismiss(MODEL_DOWNLOAD_TOAST_ID);
    playbackRefreshRef.current?.stop();
    playbackRefreshRef.current = null;
    pendingCursorOrdinalRef.current = null;
    if (playbackCursorIntervalRef.current) {
      clearInterval(playbackCursorIntervalRef.current);
      playbackCursorIntervalRef.current = null;
    }
    if (playbackEventsRef.current) {
      try {
        playbackEventsRef.current.stop();
      } catch {
        // Ignore teardown errors.
      }
      playbackEventsRef.current = null;
    }
  }, []);

  const startPlaybackForegroundSync = useCallback((runId: number) => {
    const activeSession = playbackSessionRef.current;
    if (!activeSession) return;

    stopPlaybackForegroundSync();
    usageLimitRefreshRunRef.current = null;
    const refresh = createCoalescedPlaybackRefresh(async (signal) => {
      if (runId !== playbackRunIdRef.current || playbackSessionRef.current !== activeSession) return;
      const readSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const timeline = await refreshPlaybackTimeline(activeSession.timelineUrl, readSignal);
      if (readSignal.aborted || runId !== playbackRunIdRef.current
        || playbackSessionRef.current !== activeSession) return;
      setPlaybackSeekLayout({
        planId: activeSession.planId,
        sessionId: timeline.sessionId,
        startOrdinal: timeline.startOrdinal,
        generationStartOrdinal: timeline.generationStartOrdinal,
        status: timeline.status,
        durationMs: timeline.durationMs,
        segments: timeline.segments,
      });
    }, { minIntervalMs: 250 });
    playbackRefreshRef.current = refresh;
    refresh.request();
    let lastRefreshSnapshotKey = '';
    const events = createPlaybackOperationSubscription<TtsPlaybackEventSnapshot>({
      subscribe: (operationId, onSnapshot) => subscribeTtsPlaybackEvents(activeSession.sessionId, { onSnapshot }, operationId),
      onSnapshot: (snapshot) => {
        if (runId !== playbackRunIdRef.current) return;
        if (snapshot.stopReason === 'usage_limit' && usageLimitRefreshRunRef.current !== runId) {
          usageLimitRefreshRunRef.current = runId;
          void refreshComputeUsage();
        }
        if (snapshot.status === 'failed') {
          toast.dismiss(MODEL_DOWNLOAD_TOAST_ID);
          // Publish the terminal read model to media recovery. It will detach
          // the failed stream instead of letting the browser retry a 409 URL.
          refresh.request();
          return;
        }
        if (snapshot.phase === 'downloading_model') {
          const percent = snapshot.totalBytes && snapshot.downloadedBytes !== null
            ? Math.round((snapshot.downloadedBytes / snapshot.totalBytes) * 100)
            : null;
          toast.loading(
            percent === null
              ? 'Preparing word-timing model in the cloud…'
              : `Preparing word-timing model in the cloud… ${percent}%`,
            { id: MODEL_DOWNLOAD_TOAST_ID },
          );
          // Audio is already available without exact word timing. Download-only
          // progress does not change either playback read model, so avoid two
          // redundant HTTP reads for every model checkpoint.
          return;
        }
        toast.dismiss(MODEL_DOWNLOAD_TOAST_ID);
        const refreshSnapshotKey = [
          snapshot.status,
          snapshot.completedThroughOrdinal ?? '',
          snapshot.completedCount ?? '',
          snapshot.plannedCount ?? '',
          snapshot.stopReason ?? '',
        ].join(':');
        if (refreshSnapshotKey === lastRefreshSnapshotKey) return;
        lastRefreshSnapshotKey = refreshSnapshotKey;
        refresh.request();
      },
    });
    playbackEventsRef.current = events;
    updateWorkerPlaybackCursor();
    playbackCursorIntervalRef.current = setInterval(() => {
      if (runId === playbackRunIdRef.current) updateWorkerPlaybackCursor();
    }, TTS_PLAYBACK_CURSOR_HEARTBEAT_MS);
  }, [
    playbackRunIdRef,
    playbackSessionRef,
    refreshComputeUsage,
    refreshPlaybackTimeline,
    setPlaybackSeekLayout,
    stopPlaybackForegroundSync,
    updateWorkerPlaybackCursor,
  ]);

  return {
    setWorkerPlaybackActive,
    startPlaybackForegroundSync,
    stopPlaybackForegroundSync,
    updateWorkerPlaybackCursor,
  };
}

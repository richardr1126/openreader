'use client';

import { useCallback, useRef, useState, type MutableRefObject } from 'react';

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
import { describeModelDownload, type PlaybackModelDownload } from '@/lib/client/tts/model-download';
import { PLAYBACK_CURSOR_READ_LIMIT } from '@/lib/client/tts/playback-control';

type UsePlaybackForegroundSyncInput = {
  playbackCursorOrdinalRef: MutableRefObject<number | null>;
  playbackRequestHeadersRef: MutableRefObject<TTSRequestHeaders | null>;
  playbackRunIdRef: MutableRefObject<number>;
  playbackSessionRef: MutableRefObject<PlaybackSessionState | null>;
  refreshPlaybackTimeline: (timelineUrl: string, signal?: AbortSignal,
    readWindow?: { minOrdinal: number; limit: number }) => Promise<TtsPlaybackGrid>;
  setPlaybackSeekLayout: (layout: TtsPlaybackSeekLayout | null) => void;
};

type PlaybackOperationSubscription = {
  update: (operationId: string | null) => void;
  stop: () => void;
};

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
  const playbackCommandWriteRef = useRef<Promise<void>>(Promise.resolve());
  const playbackRefreshRef = useRef<ReturnType<typeof createCoalescedPlaybackRefresh> | null>(null);
  const playbackOverviewRefreshRef = useRef<ReturnType<typeof createCoalescedPlaybackRefresh> | null>(null);
  const playbackCursorWriteRef = useRef(false);
  const pendingCursorOrdinalRef = useRef<number | null>(null);
  const usageLimitRefreshRunRef = useRef<number | null>(null);
  const [modelDownload, setModelDownload] = useState<PlaybackModelDownload | null>(null);

  const setWorkerPlaybackActive = useCallback((playbackActive: boolean, requireAcknowledgement = false) => {
    const session = playbackSessionRef.current;
    const headers = playbackRequestHeadersRef.current;
    const ordinal = playbackCursorOrdinalRef.current;
    if (!session || !headers || ordinal == null) return Promise.resolve();
    // Activity and cursor updates share one queue. Resolve the ordinal when
    // dispatching so an old queued activity write cannot undo a newer seek.
    const write = playbackCommandWriteRef.current.then(async () => {
      if (playbackActive && playbackSessionRef.current !== session) return;
      const currentOrdinal = playbackSessionRef.current === session
        ? playbackCursorOrdinalRef.current ?? ordinal : ordinal;
      await postTtsPlaybackCursor(session.sessionId, Math.max(0, currentOrdinal), headers, {
        playbackActive,
        sessionInstanceId: session.sessionInstanceId,
        requireAcknowledgement,
        keepalive: !playbackActive,
      });
    });
    playbackCommandWriteRef.current = write.catch(() => undefined);
    return write;
  }, [playbackCursorOrdinalRef, playbackRequestHeadersRef, playbackSessionRef]);

  const updateWorkerPlaybackCursor = useCallback((ordinal?: number) => {
    const requestedOrdinal = ordinal ?? playbackCursorOrdinalRef.current;
    if (requestedOrdinal == null || !Number.isFinite(requestedOrdinal)) return;
    const cursor = Math.max(0, Math.floor(requestedOrdinal));
    const cursorChanged = playbackCursorOrdinalRef.current !== cursor;
    playbackCursorOrdinalRef.current = cursor;
    if (cursorChanged) playbackRefreshRef.current?.request({ supersede: true });
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
          const write = playbackCommandWriteRef.current.then(() => {
            if (runId !== playbackRunIdRef.current || playbackSessionRef.current !== session) return null;
            return postTtsPlaybackCursor(session.sessionId, playbackCursorOrdinalRef.current ?? nextOrdinal, headers, {
              sessionInstanceId: session.sessionInstanceId,
            });
          });
          playbackCommandWriteRef.current = write.then(() => undefined, () => undefined);
          const updated = await write.catch(() => null);
          if (updated && runId === playbackRunIdRef.current
            && playbackSessionRef.current === session
            && playbackEventsRef.current === events) {
            // A new operation's first snapshot reads the timeline; the
            // heartbeat itself never does.
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

  const teardownForegroundSync = useCallback(() => {
    playbackRefreshRef.current?.stop();
    playbackRefreshRef.current = null;
    playbackOverviewRefreshRef.current?.stop();
    playbackOverviewRefreshRef.current = null;
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

  const stopPlaybackForegroundSync = useCallback(() => {
    teardownForegroundSync();
    setModelDownload(null);
  }, [teardownForegroundSync]);

  const startPlaybackForegroundSync = useCallback((runId: number) => {
    const activeSession = playbackSessionRef.current;
    if (!activeSession) return;

    // A restart keeps the download popup until the new subscription's first
    // snapshot replaces it, so a seek or recovery does not make it blink.
    teardownForegroundSync();
    usageLimitRefreshRunRef.current = null;
    const isCurrent = () => runId === playbackRunIdRef.current
      && playbackSessionRef.current === activeSession;
    const publish = (timeline: TtsPlaybackGrid) => {
      if (!isCurrent()) return;
      setPlaybackSeekLayout({
        planId: activeSession.planId,
        sessionId: timeline.sessionId,
        startOrdinal: timeline.startOrdinal,
        generationStartOrdinal: timeline.generationStartOrdinal,
        status: timeline.status,
        durationMs: timeline.durationMs,
        segments: timeline.segments,
      });
    };
    const overview = createCoalescedPlaybackRefresh(async (signal) => {
      if (!isCurrent()) return;
      const timeline = await refreshPlaybackTimeline(activeSession.timelineUrl, signal);
      if (!signal.aborted) publish(timeline);
    }, { minIntervalMs: 1500 });
    playbackOverviewRefreshRef.current = overview;
    const refresh = createCoalescedPlaybackRefresh(async (signal) => {
      if (!isCurrent()) return;
      const readSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      const timeline = await refreshPlaybackTimeline(activeSession.timelineUrl, readSignal, {
        minOrdinal: Math.max(0, playbackCursorOrdinalRef.current ?? 0), limit: PLAYBACK_CURSOR_READ_LIMIT,
      });
      if (readSignal.aborted || !isCurrent()) return;
      publish(timeline);
    }, { minIntervalMs: 250 });
    playbackRefreshRef.current = refresh;
    refresh.request();
    let lastRefreshSnapshotKey = '';
    const events = createPlaybackOperationSubscription<TtsPlaybackEventSnapshot>({
      subscribe: (operationId, onSnapshot) => subscribeTtsPlaybackEvents(activeSession.sessionId, { onSnapshot }, operationId),
      onSnapshot: (snapshot, operationId) => {
        if (runId !== playbackRunIdRef.current) return;
        if (snapshot.stopReason === 'usage_limit' && usageLimitRefreshRunRef.current !== runId) {
          usageLimitRefreshRunRef.current = runId;
          void refreshComputeUsage();
        }
        setModelDownload(describeModelDownload(snapshot));
        if (snapshot.status === 'failed') {
          // Publish the terminal read model to media recovery. It will detach
          // the failed stream instead of letting the browser retry a 409 URL.
          refresh.request();
          return;
        }
        const refreshSnapshotKey = [
          operationId,
          snapshot.status,
          snapshot.completedThroughOrdinal ?? '',
          snapshot.completedCount ?? '',
          snapshot.plannedCount ?? '',
          snapshot.alignedCount ?? '',
          snapshot.stopReason ?? '',
        ].join(':');
        if (refreshSnapshotKey === lastRefreshSnapshotKey) return;
        lastRefreshSnapshotKey = refreshSnapshotKey;
        refresh.request();
        // The cursor window covers what a run generates ahead of the cursor.
        // The whole-document overview is read once playback starts, when a
        // run ends, and when audio completes outside that window.
        const cursor = Math.max(0, playbackCursorOrdinalRef.current ?? 0);
        const completedThrough = snapshot.completedThroughOrdinal;
        if (snapshot.status === 'succeeded' || (completedThrough != null && completedThrough >= 0
          && (completedThrough < cursor || completedThrough >= cursor + PLAYBACK_CURSOR_READ_LIMIT))) {
          overview.request();
        }
      },
    });
    playbackEventsRef.current = events;
    updateWorkerPlaybackCursor();
    playbackCursorIntervalRef.current = setInterval(() => {
      if (runId === playbackRunIdRef.current) updateWorkerPlaybackCursor();
    }, TTS_PLAYBACK_CURSOR_HEARTBEAT_MS);
  }, [
    playbackCursorOrdinalRef,
    playbackRunIdRef,
    playbackSessionRef,
    refreshComputeUsage,
    refreshPlaybackTimeline,
    setPlaybackSeekLayout,
    teardownForegroundSync,
    updateWorkerPlaybackCursor,
  ]);

  const refreshPlaybackOverview = useCallback(() => {
    playbackOverviewRefreshRef.current?.request();
  }, []);

  return {
    modelDownload,
    setWorkerPlaybackActive,
    startPlaybackForegroundSync,
    stopPlaybackForegroundSync,
    updateWorkerPlaybackCursor,
    refreshPlaybackOverview,
  };
}

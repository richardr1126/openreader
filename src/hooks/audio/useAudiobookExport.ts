'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  subscribeTtsExportArtifactEvents,
  subscribeTtsExportGenerationEvents,
} from '@/lib/client/api/tts';
import { describeExportIssue, describeExportRequestError } from '@/lib/client/audiobook-export-issues';
import { useLatestRef } from '@/hooks/useLatestRef';
import type { TtsDocumentAudioExportRequest } from '@/hooks/audio/useTtsDocumentExport';
import type { TtsExportAction, TtsExportResolveSnapshot } from '@/types/tts-export';

// Chapter progress is a read model refresh, not a stream: SSE progress only
// triggers it, at most this often, while the export sidebar is open.
const PROGRESS_REFRESH_INTERVAL_MS = 5_000;
const STREAM_RECONNECT_DELAY_MS = 2_000;
// A background refresh that fails (for example while the worker redeploys)
// retries with backoff instead of interrupting the reader with a dialog.
const REFRESH_RETRY_MAX_DELAY_MS = 30_000;

function isClosedEventSource(event: Event): boolean {
  const source = event.target as EventSource | null;
  return source?.readyState === EventSource.CLOSED;
}

type ExportFormat = 'mp3' | 'm4b';

export type AudiobookExportLiveCounts = {
  completed: number;
  skipped: number;
  planned: number;
};

export type AudiobookChapterDownloadState = { status: 'preparing'; progress: number | null } | { status: 'error'; message: string };

type ResolveExport = (
  request: TtsDocumentAudioExportRequest,
  signal?: AbortSignal,
) => Promise<TtsExportResolveSnapshot>;

/**
 * Saves a same-origin export file. The `download` attribute makes this a
 * download rather than a navigation, which WebKit requires once the click is
 * no longer inside the user gesture (chapter files resolve asynchronously).
 */
export function triggerDownload(download: { url: string; filename: string }): void {
  const link = document.createElement('a');
  link.href = download.url;
  link.download = download.filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function progressPercent(completed: number | null, planned: number | null): number | null {
  if (completed === null || !planned) return null;
  return Math.max(0, Math.min(100, Math.round((completed / planned) * 100)));
}

/**
 * Owns one document's audiobook export lifecycle for the current voice/format/
 * speed: resolving the server snapshot, following the active worker operation
 * over SSE, building the file once generation completes, and per-chapter
 * downloads. The server snapshot is the single source of truth; SSE frames only
 * update live counters and trigger a fresh snapshot.
 */
export function useAudiobookExport(input: {
  documentId: string;
  /** The sidebar is open; hydrate and refresh chapter progress. */
  isOpen: boolean;
  /** Voice/model/native speed identity; a change is a different export. */
  settingsKey: string | null;
  format: ExportFormat;
  speed: number;
  resolve: ResolveExport;
}) {
  const { documentId, isOpen, settingsKey, format, speed, resolve } = input;
  const [snapshot, setSnapshot] = useState<TtsExportResolveSnapshot | null>(null);
  const [liveCounts, setLiveCounts] = useState<AudiobookExportLiveCounts | null>(null);
  const [artifactProgress, setArtifactProgress] = useState<number | null>(null);
  const [artifactPhase, setArtifactPhase] = useState<'assembling' | 'transcoding' | 'uploading' | null>(null);
  const [checkingCache, setCheckingCache] = useState(false);
  const [pendingAction, setPendingAction] = useState<TtsExportAction | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [chapterDownloads, setChapterDownloads] = useState<Record<number, AudiobookChapterDownloadState>>({});

  const exportKey = settingsKey ? `${documentId}|${settingsKey}|${format}|${speed.toFixed(2)}` : null;
  const exportKeyRef = useLatestRef(exportKey);
  const isOpenRef = useLatestRef(isOpen);
  const requestControllerRef = useRef<AbortController | null>(null);
  const lastRefreshAtRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoBuildAttemptRef = useRef<string | null>(null);
  const chapterSubscriptionsRef = useRef(new Map<number, () => void>());
  const chapterRetryTimersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  // Bumped when this export's lifecycle ends (settings change or unmount), so
  // an in-flight chapter request can neither subscribe nor download afterward.
  const lifecycleRef = useRef(0);
  const refreshFailuresRef = useRef(0);
  const onRefreshFailedRef = useRef<(failures: number) => void>(() => undefined);
  const trailingRefreshRef = useRef<'lookup' | 'details' | null>(null);
  const requestModeRef = useRef<'command' | 'lookup' | 'details' | null>(null);
  const refreshRef = useRef<(mode: 'lookup' | 'details') => void>(() => undefined);

  const run = useCallback(async (action: TtsExportAction, options?: { quiet?: boolean; includeProgress?: boolean; urgent?: boolean }) => {
    const key = exportKeyRef.current;
    if (!key) return;
    // Background refreshes never preempt a user action (Stop, Resume, ...);
    // that action's own response is the newer snapshot.
    if (options?.quiet && requestControllerRef.current
      && !(options.urgent && requestModeRef.current === 'details')) {
      if (options.urgent) trailingRefreshRef.current = 'lookup';
      else trailingRefreshRef.current ??= 'details';
      return;
    }
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    requestModeRef.current = options?.quiet
      ? options.includeProgress ? 'details' : 'lookup' : 'command';
    if (!options?.quiet) setPendingAction(action);
    try {
      const includeProgress = options?.includeProgress ?? Boolean(options?.quiet);
      const next = await resolve({ format, speed, action, includeProgress }, controller.signal);
      if (controller.signal.aborted || exportKeyRef.current !== key) return;
      lastRefreshAtRef.current = Date.now();
      refreshFailuresRef.current = 0;
      setSnapshot((previous) => ({ ...next, progress: next.progress ?? previous?.progress ?? null }));
      if (includeProgress) setLiveCounts(null);
      if (!options?.quiet) setRequestError(null);
      setRefreshError(null);
      if (!includeProgress) trailingRefreshRef.current ??= 'details';
    } catch (error) {
      if (controller.signal.aborted || exportKeyRef.current !== key) return;
      if (options?.quiet) {
        setRefreshError(describeExportRequestError(error));
        refreshFailuresRef.current += 1;
        onRefreshFailedRef.current(refreshFailuresRef.current);
        return;
      }
      setRequestError(describeExportRequestError(error));
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
        requestModeRef.current = null;
        if (!options?.quiet) setPendingAction(null);
        if (trailingRefreshRef.current) {
          const mode = trailingRefreshRef.current;
          trailingRefreshRef.current = null;
          refreshRef.current(mode);
        }
      }
    }
  }, [exportKeyRef, format, resolve, speed]);

  const refresh = useCallback(() => run('resolve', { quiet: true, includeProgress: false, urgent: true }), [run]);
  const refreshDetails = useCallback(() => run('resolve', { quiet: true, includeProgress: true }), [run]);
  useEffect(() => {
    refreshRef.current = (mode) => { void (mode === 'lookup' ? refresh() : refreshDetails()); };
  }, [refresh, refreshDetails]);

  // EventSource retries a dropped connection by itself, but gives up for good
  // (readyState CLOSED) when a reconnect is refused, for example after the
  // stream's time limit or while the browser suspended a background tab.
  // Reopening the streams and refreshing the snapshot catches progress up
  // without a page reload.
  const [streamEpoch, setStreamEpoch] = useState(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnect = useCallback((delayMs = STREAM_RECONNECT_DELAY_MS) => {
    if (reconnectTimerRef.current) return;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      void refresh();
      setStreamEpoch((epoch) => epoch + 1);
    }, delayMs);
  }, [refresh]);
  const reconnectIfClosed = useCallback((event: Event) => {
    if (isClosedEventSource(event)) reconnect();
  }, [reconnect]);
  useEffect(() => {
    onRefreshFailedRef.current = (failures) => reconnect(Math.min(
      REFRESH_RETRY_MAX_DELAY_MS,
      STREAM_RECONNECT_DELAY_MS * 2 ** (failures - 1),
    ));
    return () => {
      onRefreshFailedRef.current = () => undefined;
    };
  }, [reconnect]);
  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === 'visible') reconnect(0);
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    };
  }, [reconnect]);

  const scheduleRefresh = useCallback(() => {
    // After a failed refresh the backoff retry owns the next attempt.
    if (!isOpenRef.current || refreshTimerRef.current || refreshFailuresRef.current > 0) return;
    const waitMs = Math.max(0, lastRefreshAtRef.current + PROGRESS_REFRESH_INTERVAL_MS - Date.now());
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshDetails();
    }, waitMs);
  }, [isOpenRef, refreshDetails]);

  // A different voice/format/speed is a different export: drop everything
  // tied to the previous one and hydrate the new one when visible.
  useEffect(() => {
    setSnapshot(null);
    setLiveCounts(null);
    setArtifactProgress(null);
    setArtifactPhase(null);
    setCheckingCache(false);
    setRequestError(null);
    setRefreshError(null);
    setChapterDownloads({});
    autoBuildAttemptRef.current = null;
    const chapterSubscriptions = chapterSubscriptionsRef.current;
    const chapterRetryTimers = chapterRetryTimersRef.current;
    return () => {
      lifecycleRef.current += 1;
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      trailingRefreshRef.current = null;
      requestModeRef.current = null;
      setPendingAction(null);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
      chapterSubscriptions.forEach((unsubscribe) => unsubscribe());
      chapterSubscriptions.clear();
      chapterRetryTimers.forEach((timer) => clearTimeout(timer));
      chapterRetryTimers.clear();
    };
  }, [exportKey]);

  useEffect(() => {
    if (isOpen && exportKey) void run('resolve', { quiet: true, includeProgress: false });
  }, [exportKey, isOpen, run]);

  const generationState = snapshot?.generation.state ?? null;
  const generationOperationId = snapshot?.generation.operationId ?? null;
  useEffect(() => {
    if ((generationState !== 'generating' && generationState !== 'queued') || !generationOperationId) return;
    return subscribeTtsExportGenerationEvents({ opId: generationOperationId, documentId }, {
      onSnapshot: (event) => {
        setCheckingCache(event.phase === 'checking_cache');
        if (event.completedCount !== null && event.plannedCount !== null) {
          setLiveCounts({
            completed: event.completedCount,
            skipped: event.skippedCount ?? 0,
            planned: event.plannedCount,
          });
        }
        if (event.status === 'succeeded' || event.status === 'failed') void refresh();
        else scheduleRefresh();
      },
      onError: reconnectIfClosed,
    });
  }, [documentId, generationOperationId, generationState, reconnectIfClosed, refresh, scheduleRefresh, streamEpoch]);

  const artifactState = snapshot?.artifact.state ?? null;
  const artifactOperationId = snapshot?.artifact.operationId ?? null;
  useEffect(() => {
    if (artifactState !== 'building' || !artifactOperationId) {
      setArtifactProgress(null);
      setArtifactPhase(null);
      return;
    }
    return subscribeTtsExportArtifactEvents({ opId: artifactOperationId, documentId }, {
      onSnapshot: (event) => {
        setArtifactPhase(event.phase);
        setArtifactProgress(event.phase === 'assembling'
          ? progressPercent(event.completedSegments, event.plannedSegments) : null);
        if (event.status === 'succeeded' || event.status === 'failed') void refresh();
      },
      onError: reconnectIfClosed,
    });
  }, [artifactOperationId, artifactState, documentId, reconnectIfClosed, refresh, streamEpoch]);

  // Build (or rebuild after retried skips) the book file once every segment
  // is settled. One attempt per artifact/count state avoids retry loops when
  // the build fails or is admission-limited; Generate retries explicitly.
  useEffect(() => {
    if (!snapshot || snapshot.generation.state !== 'complete') return;
    if (snapshot.artifact.state !== 'none' && snapshot.artifact.state !== 'stale') return;
    const attemptKey = `${snapshot.artifactId}:${snapshot.progress?.completedSegments ?? 0}:${snapshot.progress?.skippedSegments ?? 0}`;
    if (autoBuildAttemptRef.current === attemptKey) return;
    autoBuildAttemptRef.current = attemptKey;
    void run('start');
  }, [run, snapshot]);

  const downloadChapter = useCallback(async (chapterIndex: number) => {
    const key = exportKeyRef.current;
    if (!key || chapterSubscriptionsRef.current.has(chapterIndex)
      || chapterRetryTimersRef.current.has(chapterIndex)) return;
    const lifecycle = lifecycleRef.current;
    const isCurrent = () => exportKeyRef.current === key && lifecycleRef.current === lifecycle;
    const setChapter = (state: AudiobookChapterDownloadState | null) => {
      if (!isCurrent()) return;
      setChapterDownloads((previous) => {
        const next = { ...previous };
        if (state) next[chapterIndex] = state;
        else delete next[chapterIndex];
        return next;
      });
    };
    const settle = async (action: TtsExportAction): Promise<void> => {
      try {
        const next = await resolve({ format, speed, action, chapterIndex });
        if (!isCurrent()) return;
        // A chapter request may outlive Stop/Resume. It owns only its download;
        // the main request/SSE owner refreshes book state without this older
        // response rolling a newer generation snapshot back.
        if (next.download) {
          setChapter(null);
          triggerDownload(next.download);
          return;
        }
        if (next.artifact.state === 'building' && next.artifact.operationId) {
          setChapter({ status: 'preparing', progress: null });
          const unsubscribe = subscribeTtsExportArtifactEvents({
            opId: next.artifact.operationId,
            documentId,
          }, {
            onSnapshot: (event) => {
              if (event.status === 'succeeded' || event.status === 'failed') {
                chapterSubscriptionsRef.current.get(chapterIndex)?.();
                chapterSubscriptionsRef.current.delete(chapterIndex);
                void settle('resolve');
                return;
              }
              setChapter({ status: 'preparing', progress: event.phase === 'assembling'
                ? progressPercent(event.completedSegments, event.plannedSegments) : null });
            },
            // A closed stream re-resolves the chapter, which downloads a
            // finished file or subscribes to the build again.
            onError: (event) => {
              if (!isClosedEventSource(event)) return;
              chapterSubscriptionsRef.current.get(chapterIndex)?.();
              chapterSubscriptionsRef.current.delete(chapterIndex);
              chapterRetryTimersRef.current.set(chapterIndex, setTimeout(() => {
                chapterRetryTimersRef.current.delete(chapterIndex);
                if (isCurrent()) void settle('resolve');
              }, STREAM_RECONNECT_DELAY_MS));
            },
          });
          chapterSubscriptionsRef.current.set(chapterIndex, unsubscribe);
          return;
        }
        setChapter({
          status: 'error',
          message: describeExportIssue(next.artifact.issue)
            ?? 'This chapter is not fully generated yet.',
        });
      } catch (error) {
        setChapter({ status: 'error', message: describeExportRequestError(error) });
      }
    };
    setChapter({ status: 'preparing', progress: null });
    await settle('start');
  }, [documentId, exportKeyRef, format, resolve, speed]);

  return {
    snapshot,
    liveCounts,
    artifactProgress,
    artifactPhase,
    checkingCache,
    isChecking: snapshot === null && refreshError === null,
    isLoadingChapters: snapshot !== null && snapshot.progress === null && refreshError === null,
    refreshError,
    refresh,
    pendingAction,
    requestError,
    clearRequestError: useCallback(() => setRequestError(null), []),
    chapterDownloads,
    start: useCallback(() => run('start'), [run]),
    stop: useCallback(() => run('stop'), [run]),
    retrySkipped: useCallback(() => run('retry-skipped'), [run]),
    downloadChapter,
  };
}

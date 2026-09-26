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

function triggerDownload(url: string): void {
  const link = document.createElement('a');
  link.href = url;
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
  const [pendingAction, setPendingAction] = useState<TtsExportAction | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [chapterDownloads, setChapterDownloads] = useState<Record<number, AudiobookChapterDownloadState>>({});

  const exportKey = settingsKey ? `${settingsKey}|${format}|${speed.toFixed(2)}` : null;
  const exportKeyRef = useLatestRef(exportKey);
  const isOpenRef = useLatestRef(isOpen);
  const requestControllerRef = useRef<AbortController | null>(null);
  const lastRefreshAtRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoBuildAttemptRef = useRef<string | null>(null);
  const chapterSubscriptionsRef = useRef(new Map<number, () => void>());

  const run = useCallback(async (action: TtsExportAction, options?: { quiet?: boolean }) => {
    const key = exportKeyRef.current;
    if (!key) return;
    // Background refreshes never preempt a user action (Stop, Resume, ...);
    // that action's own response is the newer snapshot.
    if (options?.quiet && requestControllerRef.current) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    if (!options?.quiet) setPendingAction(action);
    try {
      const next = await resolve({ format, speed, action }, controller.signal);
      if (controller.signal.aborted || exportKeyRef.current !== key) return;
      lastRefreshAtRef.current = Date.now();
      setSnapshot(next);
      setLiveCounts(null);
      if (!options?.quiet) setRequestError(null);
    } catch (error) {
      if (controller.signal.aborted || exportKeyRef.current !== key) return;
      setRequestError(describeExportRequestError(error));
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
        if (!options?.quiet) setPendingAction(null);
      }
    }
  }, [exportKeyRef, format, resolve, speed]);

  const refresh = useCallback(() => run('resolve', { quiet: true }), [run]);

  const scheduleRefresh = useCallback(() => {
    if (!isOpenRef.current || refreshTimerRef.current) return;
    const waitMs = Math.max(0, lastRefreshAtRef.current + PROGRESS_REFRESH_INTERVAL_MS - Date.now());
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refresh();
    }, waitMs);
  }, [isOpenRef, refresh]);

  // A different voice/format/speed is a different export: drop everything
  // tied to the previous one and hydrate the new one when visible.
  useEffect(() => {
    setSnapshot(null);
    setLiveCounts(null);
    setArtifactProgress(null);
    setRequestError(null);
    setChapterDownloads({});
    autoBuildAttemptRef.current = null;
    const chapterSubscriptions = chapterSubscriptionsRef.current;
    return () => {
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      setPendingAction(null);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
      chapterSubscriptions.forEach((unsubscribe) => unsubscribe());
      chapterSubscriptions.clear();
    };
  }, [exportKey]);

  useEffect(() => {
    if (isOpen && exportKey) void refresh();
  }, [exportKey, isOpen, refresh]);

  const generationState = snapshot?.generation.state ?? null;
  const generationOperationId = snapshot?.generation.operationId ?? null;
  useEffect(() => {
    if ((generationState !== 'generating' && generationState !== 'queued') || !generationOperationId) return;
    return subscribeTtsExportGenerationEvents({ opId: generationOperationId, documentId }, {
      onSnapshot: (event) => {
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
      // EventSource reconnects on its own; the next snapshot catches up.
      onError: () => {},
    });
  }, [documentId, generationOperationId, generationState, refresh, scheduleRefresh]);

  const artifactState = snapshot?.artifact.state ?? null;
  const artifactOperationId = snapshot?.artifact.operationId ?? null;
  useEffect(() => {
    if (artifactState !== 'building' || !artifactOperationId) {
      setArtifactProgress(null);
      return;
    }
    return subscribeTtsExportArtifactEvents({ opId: artifactOperationId, documentId }, {
      onSnapshot: (event) => {
        setArtifactProgress(progressPercent(event.completedSegments, event.plannedSegments));
        if (event.status === 'succeeded' || event.status === 'failed') void refresh();
      },
      onError: () => {},
    });
  }, [artifactOperationId, artifactState, documentId, refresh]);

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
    if (!key || chapterSubscriptionsRef.current.has(chapterIndex)) return;
    const setChapter = (state: AudiobookChapterDownloadState | null) => {
      if (exportKeyRef.current !== key) return;
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
        if (exportKeyRef.current !== key) return;
        // The chapter response carries fresh book-wide progress too.
        setSnapshot((previous) => previous
          ? { ...previous, generation: next.generation, progress: next.progress }
          : previous);
        if (next.downloadUrl) {
          setChapter(null);
          triggerDownload(next.downloadUrl);
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
              setChapter({ status: 'preparing', progress: progressPercent(event.completedSegments, event.plannedSegments) });
            },
            onError: () => {},
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

/** Audiobook contract shared by the `/api/v1` audiobook routes and the UI. */

export type TtsExportAction = 'resolve' | 'start' | 'retry-skipped' | 'stop';

/**
 * - idle: no export run exists yet for these settings.
 * - preparing: the reading plan is being built, before any audio.
 * - queued: waiting for a worker slot (another export is generating).
 * - generating: a live worker run is producing segments.
 * - complete: every segment is settled (audio or skipped silence).
 * - stopped: the user stopped the run; cached audio is kept.
 * - usage_limited: the TTS usage quota stopped the run.
 * - interrupted: the run ended early (worker restart, lost job) and can resume.
 * - failed: the run failed; `issue` explains why.
 */
export type TtsExportGenerationState =
  | 'idle'
  | 'preparing'
  | 'queued'
  | 'generating'
  | 'complete'
  | 'stopped'
  | 'usage_limited'
  | 'interrupted'
  | 'failed';

/**
 * `stale` is a ready file built before skipped segments were retried.
 * `waiting` is a build held back by a compute limit; it retries on its own.
 */
export type TtsExportArtifactState = 'none' | 'building' | 'waiting' | 'ready' | 'stale' | 'failed';

export type TtsExportIssue = {
  code: string | null;
  message: string | null;
};

export type TtsExportChapterProgress = {
  index: number;
  /** Worker fallback title; the reader may replace it with a TOC label. */
  title: string;
  spineHref: string | null;
  page: number | null;
  plannedSegments: number;
  completedSegments: number;
  skippedSegments: number;
  generatingSegments: number;
  /** Narrated audio produced so far for this chapter, at 1x. */
  durationMs: number;
};

export type TtsExportProgress = {
  plannedSegments: number;
  completedSegments: number;
  skippedSegments: number;
  lastSkipIssue: TtsExportIssue | null;
  chapters: TtsExportChapterProgress[];
};

export type AudiobookStatus =
  | TtsExportGenerationState
  | 'building'
  | 'waiting'
  | 'ready';

export type Audiobook = {
  /** Stable for one document version, settings, format, speed and chapter. */
  id: string;
  documentId: string;
  status: AudiobookStatus;
  /** Settled share of the planned segments, from 0 to 1, once known. */
  progress: number | null;
  format: 'mp3' | 'm4b';
  speed: number;
  chapter: number | null;
  /** Present only when the requested book or chapter file is ready. */
  downloadUrl: string | null;
  filename: string | null;
  webUrl: string;
  /** A page that starts the download in a signed-in browser, present with `downloadUrl`. */
  webDownloadUrl: string | null;
  /** How long a limited step waits before it is tried again. */
  retryAfterMs: number | null;
  generation: {
    state: TtsExportGenerationState;
    operationId: string | null;
    issue: TtsExportIssue | null;
  };
  segments: TtsExportProgress | null;
  artifact: {
    state: TtsExportArtifactState;
    operationId: string | null;
    issue: TtsExportIssue | null;
  };
};

/** What the page behind `webDownloadUrl` shows the person who opened it. */
export type AudiobookDownload =
  | { access: 'sign-in' }
  | { access: 'denied'; accountName: string }
  | { access: 'missing'; webPath: string }
  | { access: 'ready'; webPath: string; fileUrl: string; filename: string };

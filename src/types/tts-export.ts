/** Audiobook export control-plane contract shared by the resolve route and UI. */

export type TtsExportAction = 'resolve' | 'start' | 'retry-skipped' | 'stop';

/**
 * - idle: no export run exists yet for these settings.
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
  | 'queued'
  | 'generating'
  | 'complete'
  | 'stopped'
  | 'usage_limited'
  | 'interrupted'
  | 'failed';

/** `stale` is a ready file built before skipped segments were retried. */
export type TtsExportArtifactState = 'none' | 'building' | 'ready' | 'stale' | 'failed';

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

export type TtsExportResolveSnapshot = {
  sessionId: string;
  artifactId: string;
  chapterIndex: number | null;
  generation: {
    state: TtsExportGenerationState;
    operationId: string | null;
    issue: TtsExportIssue | null;
  };
  progress: TtsExportProgress | null;
  artifact: {
    state: TtsExportArtifactState;
    operationId: string | null;
    issue: TtsExportIssue | null;
  };
  /** Present only when the requested book or chapter file is ready. */
  download: { url: string; filename: string } | null;
};

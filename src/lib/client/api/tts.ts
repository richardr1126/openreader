import type {
  TTSRequestError,
  TTSRequestHeaders,
  TTSSegmentLocator,
  TTSSegmentSettings,
  VoicesResponse,
} from '@/types/client';
import type { ParsedPdfBlockKind } from '@/types/parsed-pdf';
import type { TTSSentenceAlignment } from '@/types/tts';
import type { TtsExportAction, TtsExportResolveSnapshot } from '@/types/tts-export';
import { normalizeLocator } from '@openreader/tts/locator';

export const getVoices = async (headers: HeadersInit, signal?: AbortSignal): Promise<VoicesResponse> => {
  const response = await fetch('/api/tts/voices', {
    headers,
    signal,
  });

  if (!response.ok) throw new Error('Failed to fetch voices');
  return await response.json();
};

export const createTtsPlaybackSession = async (
  payload: TtsPlaybackSessionPayload,
  headers: TTSRequestHeaders,
  signal?: AbortSignal,
): Promise<{
  sessionId: string;
  sessionInstanceId?: string;
  operation: unknown;
  audioUrl: string;
  timelineUrl: string;
  eventsUrl: string;
  seekLayoutUrl: string;
  expiresAt: number;
}> => {
  const response = await fetch('/api/tts/stream/sessions', {
    method: 'POST',
    headers: headers as HeadersInit,
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    let problem: unknown = null;
    try {
      problem = await response.json();
    } catch {
      problem = null;
    }
    const err = new Error(`TTS playback session failed with status ${response.status}`) as TTSRequestError;
    err.status = response.status;
    if (typeof problem === 'object' && problem !== null) {
      const rec = problem as Record<string, unknown>;
      if (typeof rec.code === 'string') err.code = rec.code;
      if (typeof rec.type === 'string') err.type = rec.type;
      if (typeof rec.title === 'string') err.title = rec.title;
      if (typeof rec.detail === 'string') err.detail = rec.detail;
    }
    throw err;
  }

  return await response.json();
};

export type TtsExportResolvePayload = TtsPlaybackSessionPayload & {
  format: 'mp3' | 'm4b';
  speed: number;
  action: TtsExportAction;
  /** Resolve or build one chapter's download instead of the whole book. */
  chapterIndex?: number;
  includeProgress?: boolean;
};

/** A failed export request, keeping the server's code and retry hint. */
export class TtsExportRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
    this.name = 'TtsExportRequestError';
  }
}

export const resolveTtsExport = async (
  payload: TtsExportResolvePayload,
  headers: TTSRequestHeaders,
  signal?: AbortSignal,
): Promise<TtsExportResolveSnapshot> => {
  const response = await fetch('/api/tts/export/resolve', {
    method: 'POST',
    headers: headers as HeadersInit,
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const problem = await response.json().catch(() => null) as Record<string, unknown> | null;
    const text = (key: string) => (typeof problem?.[key] === 'string' && problem[key] ? problem[key] as string : null);
    const retryAfterMs = Number(problem?.retryAfterMs);
    throw new TtsExportRequestError(
      text('detail') ?? text('error') ?? `Audiobook export request failed with status ${response.status}`,
      response.status,
      text('code'),
      Number.isFinite(retryAfterMs) ? retryAfterMs : null,
    );
  }

  return await response.json();
};

export type TtsPlaybackPlanPayload = {
  documentId: string;
  settings: TTSSegmentSettings;
  /** Segmentation knobs only; reading text is derived server-side. */
  planning?: { maxBlockLength?: number; language?: string; skipBlockKinds?: ParsedPdfBlockKind[] };
};

export type TtsPlaybackSessionPayload = TtsPlaybackPlanPayload & {
  /** Worker-plan start intent. Required for playback sessions. */
  startIntent: { selectedOrdinal: number };
  planId?: string;
  planObjectKey: string;
  planSignature?: string;
  generationExtent?: 'window' | 'document';
};

export type TtsPlaybackSeekLayoutSegment = {
  ordinal: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  audioState: 'pending' | 'ready' | 'generating' | 'error' | 'silent-gap' | 'missing-prefix';
  durationSource: 'estimated' | 'exact';
  generated: boolean;
  estimated: boolean;
  locator: TTSSegmentLocator | null;
  segmentKey: string | null;
  alignment: TTSSentenceAlignment | null;
};

export type TtsPlaybackSeekLayout = {
  planId: string;
  sessionId?: string;
  startOrdinal: number;
  // Worker-resolved absolute ordinal where generation/playback begins. The client
  // follows this for its current-segment index and initial audio seek.
  generationStartOrdinal: number;
  status: string | null;
  durationMs: number;
  segments: TtsPlaybackSeekLayoutSegment[];
};

/**
 * Plan-only seek layout before Play. `request` is the playback request the
 * session will start with, so the server reads that exact audio cache scope.
 */
export const getTtsPlaybackSeekLayout = async (
  planId: string,
  request: { headers: TTSRequestHeaders; payload: TtsPlaybackPlanPayload },
  signal?: AbortSignal,
): Promise<TtsPlaybackSeekLayout> => {
  const response = await fetch(`/api/tts/playback/plans/${encodeURIComponent(planId)}/seek-layout`, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify(request.payload),
    cache: 'no-store',
    signal,
  });
  if (!response.ok) {
    throw new Error(`TTS playback seek layout failed with status ${response.status}`);
  }
  const value = await response.json() as unknown;
  if (!value || typeof value !== 'object') {
    throw new Error('TTS playback seek layout response was not an object');
  }
  const rec = value as Record<string, unknown>;
  const rawSegments = Array.isArray(rec.segments) ? rec.segments : [];
  const startOrdinal = Number(rec.startOrdinal);
  const generationStartOrdinal = Number(rec.generationStartOrdinal);
  const durationMs = Number(rec.durationMs);
  if (
    !Number.isFinite(startOrdinal)
    || !Number.isFinite(generationStartOrdinal)
    || !Number.isFinite(durationMs)
  ) {
    throw new Error('TTS playback seek layout response was missing required numeric fields');
  }
  return {
    planId: typeof rec.planId === 'string' ? rec.planId : '',
    sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : undefined,
    startOrdinal: Math.max(0, Math.floor(startOrdinal)),
    generationStartOrdinal: Math.max(0, Math.floor(generationStartOrdinal)),
    status: typeof rec.status === 'string' ? rec.status : null,
    durationMs: Math.max(0, Math.floor(durationMs)),
    segments: rawSegments
      .map((item): TtsPlaybackSeekLayoutSegment | null => {
        if (!item || typeof item !== 'object') return null;
        const row = item as Record<string, unknown>;
        const ordinal = Number(row.ordinal);
        const startMs = Number(row.startMs);
        const endMs = Number(row.endMs);
        const durationMs = Number(row.durationMs);
        if (!Number.isFinite(ordinal) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
        if (endMs <= startMs) return null;
        return {
          ordinal: Math.max(0, Math.floor(ordinal)),
          startMs: Math.max(0, Math.floor(startMs)),
          endMs: Math.max(0, Math.floor(endMs)),
          durationMs: Number.isFinite(durationMs) && durationMs > 0
            ? Math.max(1, Math.floor(durationMs))
            : Math.max(1, Math.floor(endMs - startMs)),
          audioState: row.audioState === 'ready'
            || row.audioState === 'generating'
            || row.audioState === 'error'
            || row.audioState === 'silent-gap'
            || row.audioState === 'missing-prefix'
            ? row.audioState
            : row.generated === true ? 'ready' : 'pending',
          durationSource: row.durationSource === 'exact' || row.durationSource === 'estimated'
            ? row.durationSource
            : row.generated === true ? 'exact' : 'estimated',
          generated: row.generated === true || row.audioState === 'ready',
          estimated: row.estimated === true || row.durationSource === 'estimated',
          locator: row.locator && typeof row.locator === 'object'
            ? normalizeLocator(row.locator as TTSSegmentLocator)
            : null,
          segmentKey: typeof row.segmentKey === 'string' ? row.segmentKey : null,
          alignment: row.alignment && typeof row.alignment === 'object' ? row.alignment as TTSSentenceAlignment : null,
        };
      })
      .filter((item): item is TtsPlaybackSeekLayoutSegment => Boolean(item)),
  };
};

export type ModelComponentSnapshot = {
  name: string;
  totalBytes: number;
  downloadedBytes: number;
  state: 'pending' | 'downloading' | 'verifying' | 'ready' | 'failed';
};

export type TtsPlaybackEventSnapshot = {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  completedThroughOrdinal: number | null;
  completedCount: number | null;
  skippedCount: number | null;
  plannedCount: number | null;
  alignedCount: number | null;
  phase: 'downloading_model' | 'generating' | 'checking_cache' | null;
  stopReason: 'usage_limit' | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  /** Per-part download progress when the worker fetches a multi-file model. */
  modelComponents: ModelComponentSnapshot[] | null;
};

const MODEL_COMPONENT_STATES: ReadonlySet<string> = new Set(['pending', 'downloading', 'verifying', 'ready', 'failed']);

function finiteOrNull(value: unknown): number | null {
  return value !== undefined && value !== null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function parseModelComponents(value: unknown): ModelComponentSnapshot[] | null {
  if (!Array.isArray(value)) return null;
  const components = value.flatMap((entry): ModelComponentSnapshot[] => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || typeof record.state !== 'string' || !MODEL_COMPONENT_STATES.has(record.state)) {
      return [];
    }
    return [{
      name: record.name,
      totalBytes: finiteOrNull(record.totalBytes) ?? 0,
      downloadedBytes: finiteOrNull(record.downloadedBytes) ?? 0,
      state: record.state as ModelComponentSnapshot['state'],
    }];
  });
  return components.length > 0 ? components : null;
}

/** Reads one `snapshot` SSE frame of a playback or export-generation operation. */
export function parseTtsPlaybackSnapshotFrame(data: string): TtsPlaybackEventSnapshot | null {
  const payload = JSON.parse(data) as {
    snapshot?: {
      status?: TtsPlaybackEventSnapshot['status'];
      progress?: Record<string, unknown> | null;
    };
  };
  const snapshot = payload?.snapshot;
  if (!snapshot?.status) return null;
  const progress = snapshot.progress ?? null;
  const phase = progress?.phase;
  return {
    status: snapshot.status,
    completedThroughOrdinal: finiteOrNull(progress?.completedThroughOrdinal),
    completedCount: finiteOrNull(progress?.completedCount),
    skippedCount: finiteOrNull(progress?.skippedCount),
    plannedCount: finiteOrNull(progress?.plannedCount),
    alignedCount: finiteOrNull(progress?.alignedCount),
    phase: phase === 'downloading_model' || phase === 'generating' || phase === 'checking_cache' ? phase : null,
    stopReason: progress?.stopReason === 'usage_limit' ? 'usage_limit' : null,
    downloadedBytes: finiteOrNull(progress?.downloadedBytes),
    totalBytes: finiteOrNull(progress?.totalBytes),
    modelComponents: parseModelComponents(progress?.modelComponents),
  };
}

/**
 * Subscribe to a playback session's worker operation-events (SSE) so playback
 * can react to segment-ready progress while the page is foregrounded. Audio
 * itself is owned by the worker progressive MP3 response.
 */
export const subscribeTtsPlaybackEvents = (
  sessionId: string,
  handlers: {
    onSnapshot: (snapshot: TtsPlaybackEventSnapshot) => void;
    onError?: (error: Event) => void;
  },
  operationId?: string,
): (() => void) => {
  const suffix = operationId ? `?operationId=${encodeURIComponent(operationId)}` : '';
  const source = new EventSource(`/api/tts/stream/${encodeURIComponent(sessionId)}/events${suffix}`);
  source.addEventListener('snapshot', (event) => {
    if (!(event instanceof MessageEvent)) return;
    try {
      const snapshot = parseTtsPlaybackSnapshotFrame(event.data);
      if (snapshot) handlers.onSnapshot(snapshot);
    } catch {
      // Ignore malformed frames so a single bad payload can't break the stream.
    }
  });
  source.addEventListener('error', (event) => {
    handlers.onError?.(event);
  });
  return () => {
    source.close();
  };
};

export const subscribeTtsExportGenerationEvents = (
  input: { opId: string; documentId: string },
  handlers: {
    onSnapshot: (snapshot: TtsPlaybackEventSnapshot) => void;
    onError?: (error: Event) => void;
  },
): (() => void) => {
  const source = new EventSource(
    `/api/tts/export/events?opId=${encodeURIComponent(input.opId)}&documentId=${encodeURIComponent(input.documentId)}`,
  );
  source.addEventListener('snapshot', (event) => {
    if (!(event instanceof MessageEvent)) return;
    try {
      const snapshot = parseTtsPlaybackSnapshotFrame(event.data);
      if (snapshot) handlers.onSnapshot(snapshot);
    } catch {
      // Ignore malformed frames so EventSource can continue.
    }
  });
  source.addEventListener('error', (event) => {
    handlers.onError?.(event);
  });
  return () => {
    source.close();
  };
};

export const subscribeTtsExportArtifactEvents = (
  input: { opId: string; documentId: string },
  handlers: {
    onSnapshot: (snapshot: {
      status: 'queued' | 'running' | 'succeeded' | 'failed';
      phase: 'assembling' | 'transcoding' | 'uploading' | null;
      completedSegments: number | null;
      plannedSegments: number | null;
      skippedSegments: number | null;
    }) => void;
    onError?: (error: Event) => void;
  },
): (() => void) => {
  const source = new EventSource(
    `/api/tts/export/events?opId=${encodeURIComponent(input.opId)}&documentId=${encodeURIComponent(input.documentId)}`,
  );
  source.addEventListener('snapshot', (event) => {
    if (!(event instanceof MessageEvent)) return;
    try {
      const payload = JSON.parse(event.data) as {
        snapshot?: {
          status?: 'queued' | 'running' | 'succeeded' | 'failed';
          progress?: {
            phase?: 'assembling' | 'transcoding' | 'uploading';
            completedSegments?: number;
            plannedSegments?: number;
            skippedSegments?: number;
          } | null;
        };
      };
      const snapshot = payload?.snapshot;
      if (!snapshot?.status) return;
      const progress = snapshot.progress ?? null;
      handlers.onSnapshot({
        status: snapshot.status,
        phase: progress?.phase ?? null,
        completedSegments: progress && Number.isFinite(Number(progress.completedSegments))
          ? Number(progress.completedSegments)
          : null,
        plannedSegments: progress && Number.isFinite(Number(progress.plannedSegments))
          ? Number(progress.plannedSegments)
          : null,
        skippedSegments: progress && Number.isFinite(Number(progress.skippedSegments))
          ? Number(progress.skippedSegments)
          : null,
      });
    } catch {
      // Ignore malformed frames so EventSource can continue.
    }
  });
  source.addEventListener('error', (event) => {
    handlers.onError?.(event);
  });
  return () => {
    source.close();
  };
};

/**
 * Heartbeat the client's playback cursor to the session. The worker throttles
 * how far ahead it generates to this cursor while connected; when it goes stale
 * the worker keeps generating to the admin background extent. Best-effort.
 */
export const postTtsPlaybackCursor = async (
  sessionId: string,
  ordinal: number,
  headers: TTSRequestHeaders,
  options: { keepalive?: boolean; signal?: AbortSignal; playbackActive?: boolean; sessionInstanceId: string; requireAcknowledgement?: boolean },
): Promise<{ workerOpId: string | null } | null> => {
  const response = await fetch(`/api/tts/stream/${encodeURIComponent(sessionId)}/cursor`, {
    method: 'POST',
    headers: headers as HeadersInit,
    body: JSON.stringify({
      ordinal,
      sessionInstanceId: options.sessionInstanceId,
      ...(options.playbackActive === undefined
        ? {}
        : { playbackActive: options.playbackActive }),
    }),
    keepalive: options.keepalive ?? false,
    signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]),
  }).catch(() => null);
  if (!response?.ok) {
    if (options.requireAcknowledgement) throw new Error('Playback activation could not be confirmed');
    return null;
  }
  return response.json().catch(() => null);
};

/** A voice preview the server refused, with a message fit to show inline. */
export class VoicePreviewRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = 'VoicePreviewRequestError';
  }
}

/** Fetches a short, uncached MP3 sample of `text` spoken with draft settings. */
export const fetchVoicePreview = async (
  payload: { settings: TTSSegmentSettings; text: string },
  signal?: AbortSignal,
): Promise<Blob> => {
  const response = await fetch('/api/tts/voice-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as { code?: unknown } | null;
    const code = typeof problem?.code === 'string' ? problem.code : null;
    const message = response.status === 429
      ? 'Previews are limited right now. Try again shortly.'
      : 'Preview is unavailable right now.';
    throw new VoicePreviewRequestError(message, response.status, code);
  }
  return await response.blob();
};

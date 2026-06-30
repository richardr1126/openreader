import type {
  TTSRequestError,
  TTSRequestHeaders,
  TTSSegmentLocator,
  TTSSegmentSettings,
  VoicesResponse,
} from '@/types/client';
import type { ParsedPdfBlockKind } from '@/types/parsed-pdf';
import type { TTSSentenceAlignment } from '@/types/tts';
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
  operation: unknown;
  audioUrl: string;
  downloadUrl: string;
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

export const createTtsPlaybackPlan = async (
  payload: TtsPlaybackPlanPayload,
  headers: TTSRequestHeaders,
  signal?: AbortSignal,
): Promise<{
  planId: string;
  operation: unknown;
  planUrl: string;
  seekLayoutUrl: string;
}> => {
  const response = await fetch('/api/tts/playback/plans', {
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
    const err = new Error(`TTS playback plan failed with status ${response.status}`) as TTSRequestError;
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

export const getTtsPlaybackSeekLayout = async (
  seekLayoutUrl: string,
  signal?: AbortSignal,
): Promise<TtsPlaybackSeekLayout> => {
  const response = await fetch(seekLayoutUrl, {
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

export type TtsPlaybackEventSnapshot = {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  completedThroughOrdinal: number | null;
  completedCount: number | null;
  plannedCount: number | null;
};

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
): (() => void) => {
  const source = new EventSource(`/api/tts/stream/${encodeURIComponent(sessionId)}/events`);
  source.addEventListener('snapshot', (event) => {
    if (!(event instanceof MessageEvent)) return;
    try {
      const payload = JSON.parse(event.data) as {
        snapshot?: {
          status?: 'queued' | 'running' | 'succeeded' | 'failed';
          progress?: {
            completedThroughOrdinal?: number;
            completedCount?: number;
            plannedCount?: number;
          } | null;
        };
      };
      const snapshot = payload?.snapshot;
      if (!snapshot?.status) return;
      const progress = snapshot.progress ?? null;
      handlers.onSnapshot({
        status: snapshot.status,
        completedThroughOrdinal: progress && Number.isFinite(Number(progress.completedThroughOrdinal))
          ? Number(progress.completedThroughOrdinal)
          : null,
        completedCount: progress && Number.isFinite(Number(progress.completedCount))
          ? Number(progress.completedCount)
          : null,
        plannedCount: progress && Number.isFinite(Number(progress.plannedCount))
          ? Number(progress.plannedCount)
          : null,
      });
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

/**
 * Heartbeat the client's playback cursor to the session. The worker throttles
 * how far ahead it generates to this cursor while connected; when it goes stale
 * the worker keeps generating to the admin background extent. Best-effort.
 */
export const postTtsPlaybackCursor = async (
  sessionId: string,
  ordinal: number,
  headers: TTSRequestHeaders,
  options?: { keepalive?: boolean; signal?: AbortSignal },
): Promise<void> => {
  await fetch(`/api/tts/stream/${encodeURIComponent(sessionId)}/cursor`, {
    method: 'POST',
    headers: headers as HeadersInit,
    body: JSON.stringify({ ordinal }),
    keepalive: options?.keepalive ?? false,
    signal: options?.signal,
  }).catch(() => undefined);
};

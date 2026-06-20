import type {
  TTSRequestError,
  TTSRequestHeaders,
  TTSSegmentSettings,
  VoicesResponse,
} from '@/types/client';

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
  timelineUrl: string;
  planUrl: string;
  eventsUrl: string;
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

export type TtsPlaybackSessionPayload = {
  documentId: string;
  settings: TTSSegmentSettings;
  /** Current reading position; the worker derives reading text from here. */
  startLocation?: { page?: number; spineIndex?: number; charOffset?: number };
  /** Optional exact segment hint so worker-owned playback starts at the clicked sentence. */
  startSegmentKey?: string;
  startText?: string;
  /** Segmentation knobs only; reading text is derived server-side. */
  planning?: { maxBlockLength?: number; language?: string };
};

export const createTtsPlaybackPlanSession = async (
  payload: TtsPlaybackSessionPayload,
  headers: TTSRequestHeaders,
  signal?: AbortSignal,
): Promise<{
  sessionId: string;
  operation: unknown;
  timelineUrl: string;
  planUrl: string;
  eventsUrl: string;
  expiresAt: number;
}> => {
  const response = await fetch('/api/tts/stream/sessions', {
    method: 'POST',
    headers: headers as HeadersInit,
    body: JSON.stringify({ ...payload, planOnly: true }),
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

export type TtsPlaybackEventSnapshot = {
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  completedThroughOrdinal: number | null;
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
          progress?: { completedThroughOrdinal?: number; plannedCount?: number } | null;
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

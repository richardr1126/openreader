import type { TtsPlaybackPhase } from '@/types/tts';
import {
  isPlaybackBufferReady,
  isPlaybackSlotPlayable,
  measurePlaybackBuffer,
  type PlaybackBufferSegment,
  PLAYBACK_START_BUFFER_WALL_MS,
  PLAYBACK_PROGRESS_TIMEOUT_MS,
} from '@openreader/tts/playback-buffer';

export { PLAYBACK_START_BUFFER_WALL_MS } from '@openreader/tts/playback-buffer';

export const PLAYBACK_CURSOR_READ_LIMIT = 64;

type PlaybackStartLayout = {
  sessionId?: string;
  status: string | null;
  generationStartOrdinal: number;
  segments: PlaybackBufferSegment[];
};

/** Bound an SSE readiness wait by both idle time and total time at one target. */
export function createPlaybackReadinessDeadline(options: {
  timeoutMs?: number;
  maxWaitMs?: number;
  now?: () => number;
} = {}) {
  const now = options.now ?? Date.now;
  const idleMs = Math.max(1, options.timeoutMs ?? 60_000);
  const maxWaitMs = Math.max(idleMs, options.maxWaitMs ?? PLAYBACK_PROGRESS_TIMEOUT_MS);
  let targetKey: string | null = null;
  let startedAt = now();
  let lastProgressAt = startedAt;
  const readyOrdinals = new Set<number>();
  return (startOrdinal: number | undefined, offsetMs: number, segments: PlaybackBufferSegment[]) => {
    const observedAt = now();
    const key = `${startOrdinal}:${offsetMs}`;
    if (key !== targetKey) {
      targetKey = key;
      startedAt = observedAt;
      lastProgressAt = observedAt;
      readyOrdinals.clear();
    }
    if (startOrdinal !== undefined) {
      for (const segment of segments) {
        if (segment.ordinal < startOrdinal || segment.ordinal >= startOrdinal + PLAYBACK_CURSOR_READ_LIMIT
          || !isPlaybackSlotPlayable(segment) || readyOrdinals.has(segment.ordinal)) continue;
        readyOrdinals.add(segment.ordinal);
        lastProgressAt = observedAt;
      }
    }
    return Math.max(0, Math.min(lastProgressAt + idleMs, startedAt + maxWaitMs) - observedAt);
  };
}

export function isPlaybackAbortError(error: unknown): boolean {
  // Fetch deadlines are failures that must settle loading and allow retry.
  // Their native message also contains "aborted", unlike a user cancellation.
  if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'TimeoutError') return false;
  if (error instanceof Error) {
    return error.name === 'AbortError' || /abort|cancel/i.test(error.message || '');
  }
  if (typeof error === 'string') return /abort|cancel/i.test(error);
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' && /abort|cancel/i.test(message);
  }
  return false;
}

export type PlaybackMediaResumeResult =
  | { status: 'resumed' }
  | { status: 'cancelled' }
  | { status: 'stale'; error: unknown };

/**
 * A failed media resume may reconnect only while it still owns playback
 * intent. A pause or replacement run that wins meanwhile cancels recovery.
 */
export async function resumePlaybackMedia(
  play: () => Promise<void> | void,
  isCurrent: () => boolean,
): Promise<PlaybackMediaResumeResult> {
  try {
    await play();
    return isCurrent() ? { status: 'resumed' } : { status: 'cancelled' };
  } catch (error) {
    return isCurrent() ? { status: 'stale', error } : { status: 'cancelled' };
  }
}

export type PlaybackStartBuffer = {
  durationMs: number;
  segmentCount: number;
  reachedDocumentEnd: boolean;
};

/** Await the browser's accepted position; cancellation releases every listener. */
export function positionPlaybackMedia(
  audio: HTMLAudioElement,
  seconds: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'seeked'] as const;
    let positioned = false;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      for (const event of events) audio.removeEventListener(event, check);
      audio.removeEventListener('error', failed);
      if (error) reject(error); else resolve(!signal.aborted);
    };
    const aborted = () => finish();
    const failed = () => finish(new Error('The audio connection failed while seeking'));
    const check = () => {
      if (signal.aborted) { finish(); return; }
      if (audio.readyState < 1) return;
      if (!positioned) {
        positioned = true;
        try { audio.currentTime = seconds; } catch (error) {
          finish(error instanceof Error ? error : new Error('The browser rejected the audio position'));
          return;
        }
      }
      if (!audio.seeking && audio.readyState >= 2 && Math.abs(audio.currentTime - seconds) < 0.25) finish();
    };
    const timer = setTimeout(() => finish(new Error('The browser did not accept the audio position in time')), 30_000);
    signal.addEventListener('abort', aborted, { once: true });
    for (const event of events) audio.addEventListener(event, check);
    audio.addEventListener('error', failed, { once: true });
    check();
  });
}

export function measurePlaybackStartBuffer(
  segments: PlaybackBufferSegment[],
  startOrdinal: number,
): PlaybackStartBuffer {
  const result = measurePlaybackBuffer({
    segments: [...segments].sort((a, b) => a.ordinal - b.ordinal),
    startOrdinal,
  });
  return {
    durationMs: result.durationMs,
    segmentCount: result.segmentCount,
    reachedDocumentEnd: result.reachedDocumentEnd,
  };
}

export function isPlaybackStartBufferReady(input: {
  segments: PlaybackBufferSegment[];
  startOrdinal: number;
  playbackRate: number;
  minimumWallMs?: number;
  offsetWithinStartSegmentMs?: number;
}): boolean {
  return isPlaybackBufferReady({
    segments: input.segments,
    startOrdinal: input.startOrdinal,
    playbackRate: input.playbackRate,
    minimumWallMs: input.minimumWallMs ?? PLAYBACK_START_BUFFER_WALL_MS,
    offsetWithinStartSegmentMs: input.offsetWithinStartSegmentMs,
  });
}

export async function waitForPlaybackStartBuffer<T extends PlaybackStartLayout>(input: {
  sessionId: string;
  loadLayout: () => Promise<T | null>;
  isCurrent: () => boolean;
  playbackRate: number;
  getStartOrdinal?: () => number;
  getStartOffsetMs?: () => number;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<T | null> {
  const remainingWait = createPlaybackReadinessDeadline({ timeoutMs: input.timeoutMs });
  for (;;) {
    if (!input.isCurrent()) return null;
    const layout = await input.loadLayout();
    if (!input.isCurrent()) return null;
    const startOrdinal = input.getStartOrdinal?.() ?? layout?.generationStartOrdinal;
    const offsetMs = input.getStartOffsetMs?.() ?? 0;
    const belongsToSession = layout?.sessionId === input.sessionId;
    const remainingMs = remainingWait(startOrdinal, offsetMs, belongsToSession ? layout.segments : []);
    if (belongsToSession && layout.status === 'failed') {
      throw new Error('TTS playback generation failed before audio became ready');
    }
    if (
      belongsToSession
      && (layout.status === 'running' || layout.status === 'succeeded')
      && isPlaybackStartBufferReady({
        segments: layout.segments,
        startOrdinal: startOrdinal ?? layout.generationStartOrdinal,
        playbackRate: input.playbackRate,
        offsetWithinStartSegmentMs: offsetMs,
      })
    ) {
      return layout;
    }
    if (remainingMs === 0) {
      throw new Error('TTS playback session did not buffer enough contiguous audio in time');
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, input.pollMs ?? 250)));
  }
}

export type PlaybackControlPresentation = {
  isPending: boolean;
  ariaLabel: 'Play' | 'Pause' | 'Cancel playback loading';
  statusText: 'Preparing audio…' | 'Loading audio…' | null;
};

export function isPlaybackPhaseProcessing(
  isPlaying: boolean,
  phase: TtsPlaybackPhase,
): boolean {
  return isPlaying && (
    phase === 'planning'
    || phase === 'ready'
    || phase === 'seeking'
    || phase === 'buffering'
  );
}

export function resolvePlaybackControlPresentation(
  isPlaying: boolean,
  phase: TtsPlaybackPhase,
): PlaybackControlPresentation {
  if (!isPlaying) {
    return { isPending: false, ariaLabel: 'Play', statusText: null };
  }
  if (phase === 'playing') {
    return { isPending: false, ariaLabel: 'Pause', statusText: null };
  }
  return {
    isPending: true,
    ariaLabel: 'Cancel playback loading',
    statusText: phase === 'planning' || phase === 'ready'
      ? 'Preparing audio…'
      : 'Loading audio…',
  };
}

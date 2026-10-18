import type { TtsPlaybackPhase } from '@/types/tts';
import {
  isPlaybackBufferReady,
  measurePlaybackBuffer,
  PLAYBACK_START_BUFFER_WALL_MS,
} from '@openreader/tts/playback-buffer';

export { PLAYBACK_START_BUFFER_WALL_MS } from '@openreader/tts/playback-buffer';

type PlaybackBufferSegment = {
  ordinal: number;
  durationMs: number;
  generated: boolean;
};

type PlaybackStartLayout = {
  sessionId?: string;
  status: string | null;
  generationStartOrdinal: number;
  segments: PlaybackBufferSegment[];
};

export function isPlaybackAbortError(error: unknown): boolean {
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
  const timeoutMs = Math.max(1, input.timeoutMs ?? 60_000);
  let deadline = Date.now() + timeoutMs;
  let targetKey: string | null = null;
  for (;;) {
    if (!input.isCurrent()) return null;
    const layout = await input.loadLayout();
    if (!input.isCurrent()) return null;
    const startOrdinal = input.getStartOrdinal?.() ?? layout?.generationStartOrdinal;
    const offsetMs = input.getStartOffsetMs?.() ?? 0;
    const nextTargetKey = `${startOrdinal}:${offsetMs}`;
    if (targetKey !== null && targetKey !== nextTargetKey) deadline = Date.now() + timeoutMs;
    targetKey = nextTargetKey;
    const belongsToSession = layout?.sessionId === input.sessionId;
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
    if (Date.now() > deadline) {
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

/** How much of the start buffer is ready, 0..1, for the play control's ring. */
export function playbackStartProgress(
  buffer: { wallMs: number; reachedDocumentEnd: boolean } | null,
): number {
  if (!buffer) return 0;
  if (buffer.reachedDocumentEnd) return 1;
  return Math.min(1, Math.max(0, buffer.wallMs / PLAYBACK_START_BUFFER_WALL_MS));
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

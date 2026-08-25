import type { TtsPlaybackPhase } from '@/types/tts';

export const PLAYBACK_START_BUFFER_WALL_MS = 10_000;
export const PLAYBACK_START_MIN_SEGMENTS = 2;

type PlaybackBufferSegment = {
  ordinal: number;
  durationMs: number;
  generated: boolean;
};

type PlaybackStartLayout = {
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

export type PlaybackStartBuffer = {
  durationMs: number;
  segmentCount: number;
  reachedDocumentEnd: boolean;
};

export function measurePlaybackStartBuffer(
  segments: PlaybackBufferSegment[],
  startOrdinal: number,
): PlaybackStartBuffer {
  const start = Math.max(0, Math.floor(Number(startOrdinal) || 0));
  const ordered = [...segments].sort((a, b) => a.ordinal - b.ordinal);
  const startIndex = ordered.findIndex((segment) => segment.ordinal === start);
  if (startIndex < 0) {
    return { durationMs: 0, segmentCount: 0, reachedDocumentEnd: false };
  }

  let durationMs = 0;
  let segmentCount = 0;
  for (let index = startIndex; index < ordered.length; index += 1) {
    const segment = ordered[index];
    if (!segment.generated) break;
    durationMs += Math.max(1, Math.floor(Number(segment.durationMs) || 0));
    segmentCount += 1;
  }

  return {
    durationMs,
    segmentCount,
    reachedDocumentEnd: startIndex + segmentCount >= ordered.length,
  };
}

export function isPlaybackStartBufferReady(input: {
  segments: PlaybackBufferSegment[];
  startOrdinal: number;
  playbackRate: number;
  minimumWallMs?: number;
  offsetWithinStartSegmentMs?: number;
}): boolean {
  const buffer = measurePlaybackStartBuffer(input.segments, input.startOrdinal);
  if (buffer.segmentCount === 0) return false;
  if (buffer.reachedDocumentEnd) return true;

  const playbackRate = Number.isFinite(input.playbackRate) && input.playbackRate > 0
    ? input.playbackRate
    : 1;
  const minimumWallMs = Math.max(0, Math.floor(
    input.minimumWallMs ?? PLAYBACK_START_BUFFER_WALL_MS,
  ));
  const playableDurationMs = Math.max(
    0,
    buffer.durationMs - Math.max(0, Math.floor(input.offsetWithinStartSegmentMs ?? 0)),
  );
  return buffer.segmentCount >= PLAYBACK_START_MIN_SEGMENTS
    && playableDurationMs >= minimumWallMs * playbackRate;
}

export async function waitForPlaybackStartBuffer<T extends PlaybackStartLayout>(input: {
  loadLayout: () => Promise<T | null>;
  isCurrent: () => boolean;
  playbackRate: number;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<T | null> {
  const deadline = Date.now() + Math.max(1, input.timeoutMs ?? 60_000);
  for (;;) {
    if (!input.isCurrent()) return null;
    const layout = await input.loadLayout();
    if (
      layout
      && (layout.status === 'running' || layout.status === 'succeeded')
      && isPlaybackStartBufferReady({
        segments: layout.segments,
        startOrdinal: layout.generationStartOrdinal,
        playbackRate: input.playbackRate,
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

/** Listening-time targets, shared by the player and the generation controller. */
export const PLAYBACK_START_BUFFER_WALL_MS = 10_000;
export const PLAYBACK_RECOVERY_BUFFER_WALL_MS = 20_000;
export const PLAYBACK_REFILL_WALL_MS = 45_000;
export const PLAYBACK_AHEAD_WALL_MS = 60_000;
export const PLAYBACK_PROGRESS_TIMEOUT_MS = 120_000;

export type PlaybackBufferSegment = { ordinal: number; durationMs: number; generated: boolean; audioState?: string };

/**
 * Ready audio, or a failed sentence the audio stream plays as silence for its
 * estimated slot. Either lets playback start on, seek to, or pass the slot.
 */
export function isPlaybackSlotPlayable(segment: Pick<PlaybackBufferSegment, 'generated' | 'audioState'>): boolean {
  return segment.generated || segment.audioState === 'error';
}

export function measurePlaybackBuffer(input: {
  segments: readonly PlaybackBufferSegment[];
  startOrdinal: number;
  offsetWithinStartSegmentMs?: number;
  playbackRate?: number;
}) {
  const startIndex = input.segments.findIndex((segment) => segment.ordinal === input.startOrdinal);
  let durationMs = 0;
  let segmentCount = 0;
  if (startIndex >= 0) {
    for (const segment of input.segments.slice(startIndex)) {
      if (!isPlaybackSlotPlayable(segment) || !Number.isFinite(segment.durationMs) || segment.durationMs <= 0) break;
      durationMs += segment.durationMs;
      segmentCount++;
    }
  }
  const rate = Number.isFinite(input.playbackRate) && input.playbackRate! > 0 ? input.playbackRate! : 1;
  const remainingMs = Math.max(0, durationMs - Math.max(0, input.offsetWithinStartSegmentMs ?? 0));
  return {
    durationMs: remainingMs,
    wallMs: remainingMs / rate,
    segmentCount,
    reachedDocumentEnd: startIndex >= 0 && segmentCount > 0 && startIndex + segmentCount === input.segments.length,
  };
}

export function isPlaybackBufferReady(input: Parameters<typeof measurePlaybackBuffer>[0] & { minimumWallMs?: number }) {
  const buffer = measurePlaybackBuffer(input);
  return buffer.segmentCount > 0 && (buffer.reachedDocumentEnd
    || buffer.wallMs >= (input.minimumWallMs ?? PLAYBACK_START_BUFFER_WALL_MS));
}

import { STREAM_AUDIO_BYTES_PER_SECOND } from './audio-format';

/**
 * Pure helpers that map the progressive playback stream between time, bytes,
 * and plan ordinals. The worker emits one CBR MP3 stream, so bytes and time are
 * linear: a segment of duration D occupies `D * BYTES_PER_SECOND` bytes.
 */

export const DEFAULT_MS_PER_CHAR = 65;

export function bytesForDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.max(0, Math.round((durationMs * STREAM_AUDIO_BYTES_PER_SECOND) / 1000));
}

export function estimateDurationMs(text: string, msPerChar: number): number {
  const chars = text.trim().length;
  const rate = Number.isFinite(msPerChar) && msPerChar > 0 ? msPerChar : DEFAULT_MS_PER_CHAR;
  return Math.max(1, Math.round(chars * rate));
}

export function estimateMsPerCharForNativeSpeed(nativeSpeed: unknown, baseMsPerChar = 78): number {
  const speed = Number(nativeSpeed);
  const clamped = Number.isFinite(speed) && speed > 0 ? Math.min(3, Math.max(0.5, speed)) : 1;
  return baseMsPerChar / clamped;
}

export function calibrateMsPerChar(samples: Array<{ chars: number; durationMs: number }>): number {
  let totalChars = 0;
  let totalMs = 0;
  for (const sample of samples) {
    if (sample.chars > 0 && sample.durationMs > 0) {
      totalChars += sample.chars;
      totalMs += sample.durationMs;
    }
  }
  if (totalChars === 0) return DEFAULT_MS_PER_CHAR;
  return totalMs / totalChars;
}

export interface PlanSlotInput {
  ordinal: number;
  text: string;
  locator?: unknown;
  segmentKey?: string | null;
  durationMs: number | null;
}

export interface PlaybackLayoutSlot {
  ordinal: number;
  segmentKey: string | null;
  locator: unknown;
  text: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  startByte: number;
  byteLength: number;
  generated: boolean;
  estimated: boolean;
}

export interface PlaybackCbrLayout {
  durationMs: number;
  totalBytes: number;
  slots: PlaybackLayoutSlot[];
}

export interface PlaybackCbrLayoutOptions {
  /**
   * When set, every *not-generated* (silence) slot is quantized to a whole number
   * of MP3 frames: its duration becomes `frames × MP3_FRAME_DURATION_MS`. This is
   * what makes the silence the worker emits decode to exactly the duration the grid
   * advertises — without it, a slot's byte length is an arbitrary count that gets
   * sliced mid-frame, dropping a partial frame per slot and drifting the highlight.
   * Pass it on BOTH the worker byte map and the client time grid so they agree.
   */
  frameDurationMs?: number;
  /**
   * Exact byte length for `frames` whole frames of CBR silence (worker-only; needs
   * the parsed silence frame table). When provided, silence slots use it so the
   * byte map lands on real frame boundaries. The client time grid omits it (it maps
   * by time, never bytes) and falls back to the linear CBR estimate.
   */
  silenceBytesForFrames?: (frames: number) => number;
}

export function buildPlaybackCbrLayout(
  plan: PlanSlotInput[],
  startOrdinal: number,
  msPerChar: number,
  options?: PlaybackCbrLayoutOptions,
): PlaybackCbrLayout {
  const ordered = plan
    .filter((segment) => segment.ordinal >= startOrdinal)
    .sort((a, b) => a.ordinal - b.ordinal);

  const frameMs = options?.frameDurationMs && options.frameDurationMs > 0
    ? options.frameDurationMs
    : 0;

  const slots: PlaybackLayoutSlot[] = [];
  let cursorMs = 0;
  let cursorBytes = 0;
  for (const segment of ordered) {
    const generated = segment.durationMs != null && segment.durationMs > 0;
    let durationMs: number;
    let byteLength: number;
    if (generated) {
      durationMs = Math.max(1, Math.round(segment.durationMs as number));
      byteLength = bytesForDurationMs(durationMs);
    } else if (frameMs > 0) {
      // Silence quantized to whole frames so decoded duration == byte grid.
      const frames = Math.max(1, Math.round(estimateDurationMs(segment.text, msPerChar) / frameMs));
      durationMs = Math.max(1, Math.round(frames * frameMs));
      byteLength = options?.silenceBytesForFrames
        ? options.silenceBytesForFrames(frames)
        : bytesForDurationMs(durationMs);
    } else {
      durationMs = estimateDurationMs(segment.text, msPerChar);
      byteLength = bytesForDurationMs(durationMs);
    }
    slots.push({
      ordinal: segment.ordinal,
      segmentKey: segment.segmentKey ?? null,
      locator: segment.locator ?? null,
      text: segment.text,
      startMs: cursorMs,
      endMs: cursorMs + durationMs,
      durationMs,
      startByte: cursorBytes,
      byteLength,
      generated,
      estimated: !generated,
    });
    cursorMs += durationMs;
    cursorBytes += byteLength;
  }
  return { durationMs: cursorMs, totalBytes: cursorBytes, slots };
}

export function locateByte(
  layout: Pick<PlaybackCbrLayout, 'totalBytes' | 'slots'>,
  byteOffset: number,
): { slotIndex: number; offsetWithin: number } | null {
  if (byteOffset < 0 || layout.slots.length === 0) return null;
  if (byteOffset >= layout.totalBytes) return null;

  let lo = 0;
  let hi = layout.slots.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const slot = layout.slots[mid];
    if (byteOffset < slot.startByte) {
      hi = mid - 1;
    } else if (byteOffset >= slot.startByte + slot.byteLength) {
      lo = mid + 1;
    } else {
      return { slotIndex: mid, offsetWithin: byteOffset - slot.startByte };
    }
  }
  const idx = Math.min(lo, layout.slots.length - 1);
  return { slotIndex: idx, offsetWithin: 0 };
}

export interface ParsedRange {
  start: number;
  end: number;
}

export function parseRangeHeader(
  header: string | undefined,
  totalBytes: number,
): ParsedRange | null | 'invalid' | 'unsatisfiable' {
  if (!header) return null;
  const trimmed = header.trim();
  const match = /^bytes=(\d*)-(\d*)$/.exec(trimmed);
  if (!match) return 'invalid';
  const startRaw = match[1];
  const endRaw = match[2];
  if (startRaw === '' && endRaw === '') return 'invalid';
  if (totalBytes <= 0) return 'unsatisfiable';

  let start: number;
  let end: number;
  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, totalBytes - suffix);
    end = totalBytes - 1;
  } else {
    start = Number(startRaw);
    if (!Number.isFinite(start)) return 'invalid';
    if (start >= totalBytes) return 'unsatisfiable';
    end = endRaw === '' ? totalBytes - 1 : Math.min(Number(endRaw), totalBytes - 1);
    if (!Number.isFinite(end) || end < start) return 'invalid';
  }
  return { start, end };
}

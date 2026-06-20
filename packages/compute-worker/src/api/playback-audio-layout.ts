import { STREAM_AUDIO_BYTES_PER_SECOND } from '@openreader/tts/audio-format';

/**
 * Pure helpers that map the progressive playback stream between *time* (segment
 * durations) and *bytes*. Because every segment is encoded to one CBR profile
 * (see STREAM_AUDIO_PROFILE), bytes and time are linear: a segment of duration D
 * occupies `D * BYTES_PER_SECOND` bytes. We therefore never need the segments'
 * real byte sizes — durations (exact once generated, estimated from text before)
 * fully determine the byte layout, and the browser seeks by `byte = time * rate`.
 */

/**
 * Fallback speaking rate (ms of audio per source character) used to estimate the
 * duration of not-yet-generated segments before any real segment has been
 * generated to calibrate against. ~65ms/char ≈ 150 wpm at ~6 chars/word.
 */
export const DEFAULT_MS_PER_CHAR = 65;

/** Bytes a segment of `durationMs` occupies in the CBR stream (linear, rounded). */
export function bytesForDurationMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.max(0, Math.round((durationMs * STREAM_AUDIO_BYTES_PER_SECOND) / 1000));
}

/** Estimate a not-yet-generated segment's audio duration from its text length. */
export function estimateDurationMs(text: string, msPerChar: number): number {
  const chars = text.trim().length;
  const rate = Number.isFinite(msPerChar) && msPerChar > 0 ? msPerChar : DEFAULT_MS_PER_CHAR;
  return Math.max(1, Math.round(chars * rate));
}

/**
 * Calibrate ms-per-character from already-generated segments so the estimate for
 * the pending tail tracks the actual voice/speed. Falls back to the default until
 * at least one real segment is available.
 */
export function calibrateMsPerChar(
  samples: Array<{ chars: number; durationMs: number }>,
): number {
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
  segmentIndex: number;
  text: string;
  /** Exact probed duration once generated, or null/0 while pending. */
  durationMs: number | null;
}

export interface ByteSlot {
  segmentIndex: number;
  startByte: number;
  byteLength: number;
  generated: boolean;
}

export interface ByteLayout {
  totalBytes: number;
  slots: ByteSlot[];
}

/**
 * Build the byte layout for the audio window `[startOrdinal … end]`: one
 * contiguous slot per plan segment, sized from its (exact or estimated) duration.
 * The cumulative `startByte` of each slot is the seek target the browser will
 * request for that segment's start time.
 */
export function buildByteLayout(
  plan: PlanSlotInput[],
  startOrdinal: number,
  msPerChar: number,
): ByteLayout {
  const ordered = plan
    .filter((segment) => segment.segmentIndex >= startOrdinal)
    .sort((a, b) => a.segmentIndex - b.segmentIndex);

  const slots: ByteSlot[] = [];
  let cursor = 0;
  for (const segment of ordered) {
    const generated = segment.durationMs != null && segment.durationMs > 0;
    const durationMs = generated
      ? (segment.durationMs as number)
      : estimateDurationMs(segment.text, msPerChar);
    const byteLength = bytesForDurationMs(durationMs);
    slots.push({ segmentIndex: segment.segmentIndex, startByte: cursor, byteLength, generated });
    cursor += byteLength;
  }
  return { totalBytes: cursor, slots };
}

/**
 * Locate which slot contains an absolute byte offset, and the offset within that
 * slot. Returns null when the offset is at/after the end of the layout.
 */
export function locateByte(
  layout: ByteLayout,
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
  // Fell between slots only possible when a slot has zero length; clamp to lo.
  const idx = Math.min(lo, layout.slots.length - 1);
  return { slotIndex: idx, offsetWithin: 0 };
}

export interface ParsedRange {
  /** Inclusive start byte. */
  start: number;
  /** Inclusive end byte. */
  end: number;
}

/**
 * Parse a single-range HTTP `Range` header against a known total size. Returns:
 *  - null when there is no range (serve the full body as 200),
 *  - 'invalid' for a malformed or multi-range header (caller should serve full),
 *  - 'unsatisfiable' when the range lies entirely beyond the resource (416),
 *  - a clamped { start, end } for a valid single range (206).
 */
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
    // Suffix range: last N bytes.
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

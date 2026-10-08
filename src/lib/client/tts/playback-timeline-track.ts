import type { TtsPlaybackSeekLayout } from '@/lib/client/api/tts';

/**
 * Geometry for the player's seek track. The rail is the whole document, the
 * ready bands are the stretches that already have audio (from the SSE-refreshed
 * seek layout), and the fill is what has been heard. Everything here is a
 * fraction of the document so the renderer only has to multiply by 100.
 */

type TimelineLayout = Pick<TtsPlaybackSeekLayout, 'durationMs' | 'segments'>;

export type TimelineBand = { start: number; end: number };

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Contiguous generated segments merged into document-fraction bands. */
export function readyTimelineBands(layout: TimelineLayout | null): TimelineBand[] {
  if (!layout || !(layout.durationMs > 0) || layout.segments.length === 0) return [];
  const durationMs = layout.durationMs;
  const generated = layout.segments
    .filter((segment) => segment.generated && segment.endMs > segment.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const bands: TimelineBand[] = [];
  let open: { startMs: number; endMs: number } | null = null;
  for (const segment of generated) {
    // Plan timings are rounded to whole milliseconds; a 1ms seam is still one run.
    if (open && segment.startMs <= open.endMs + 1) {
      open.endMs = Math.max(open.endMs, segment.endMs);
      continue;
    }
    if (open) bands.push({ start: open.startMs / durationMs, end: open.endMs / durationMs });
    open = { startMs: segment.startMs, endMs: segment.endMs };
  }
  if (open) bands.push({ start: open.startMs / durationMs, end: open.endMs / durationMs });
  return bands
    .map((band) => ({ start: clampFraction(band.start), end: clampFraction(band.end) }))
    .filter((band) => band.end > band.start);
}

/** One CSS gradient for every band, so a scattered cache stays one element. */
export function timelineBandsGradient(bands: readonly TimelineBand[], color: string): string | null {
  if (bands.length === 0) return null;
  const stops: string[] = [];
  for (const band of bands) {
    const start = (band.start * 100).toFixed(3);
    const end = (band.end * 100).toFixed(3);
    stops.push(`transparent ${start}%`, `${color} ${start}%`, `${color} ${end}%`, `transparent ${end}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

export function timelineFraction(positionSec: number, durationSec: number): number {
  if (!(durationSec > 0)) return 0;
  return clampFraction(positionSec / durationSec);
}

function segmentAt(layout: TimelineLayout, positionSec: number) {
  const ms = positionSec * 1000;
  return layout.segments.find((segment) => ms >= segment.startMs && ms < segment.endMs)
    ?? layout.segments[layout.segments.length - 1]
    ?? null;
}

/**
 * Where an undo should return after a scrub committed at `committedSec`, or
 * null when the scrub stayed inside the sentence it started in. Undo belongs to
 * the sentence under the playhead at touch-down and returns to its start.
 */
export function scrubUndoTargetSec(
  layout: TimelineLayout | null,
  originSec: number,
  committedSec: number,
): number | null {
  if (!layout || layout.segments.length === 0) return null;
  const origin = segmentAt(layout, originSec);
  const committed = segmentAt(layout, committedSec);
  if (!origin || !committed || origin.ordinal === committed.ordinal) return null;
  return Math.max(0, origin.startMs / 1000);
}

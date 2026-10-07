/**
 * Where the reader left off: the playback cursor, never a page.
 *
 * The segment key is content identity, so it survives a re-plan that leaves the
 * sentence intact; the ordinal rides along as a hint that makes the common
 * case (nothing changed) a single comparison. Pages, EPUB locations and HTML
 * blocks are layout-dependent views derived from the resolved segment. Reading
 * progress and bookmarks share this one shape and resolver.
 *
 * A null key is only ever stored for positions converted from the v5.0
 * page/location format, which carried an ordinal but no key; it resolves by
 * ordinal alone.
 */
export type ReadingPosition = {
  segmentKey: string | null;
  segmentOrdinal: number;
};

type PlanSegment = { key: string; ordinal: number };

export const READING_POSITION_SEGMENT_KEY_MAX_LENGTH = 512;

/** The position to store for a cursor on `ordinal`; null when the plan has no such segment. */
export function readingPositionAt(
  plan: readonly PlanSegment[],
  ordinal: number,
): (ReadingPosition & { segmentKey: string; progress: number }) | null {
  const index = plan.findIndex((segment) => segment.ordinal === ordinal);
  if (index < 0) return null;
  const segment = plan[index];
  return {
    segmentKey: segment.key,
    segmentOrdinal: segment.ordinal,
    progress: index / plan.length,
  };
}

/**
 * Resolves a stored position to an ordinal in this plan: the hinted ordinal if
 * its key still matches, else the first segment with that key, else the
 * ordinal clamped into the plan. A position that cannot be found exactly is
 * still better honoured approximately than by restarting the document. Null
 * only for an empty plan or no position.
 */
export function resolveReadingPositionOrdinal(
  plan: readonly PlanSegment[],
  position: ReadingPosition | null | undefined,
): number | null {
  if (!position || plan.length === 0) return null;
  const { segmentKey, segmentOrdinal } = position;

  const hinted = plan.find((segment) => segment.ordinal === segmentOrdinal);
  if (hinted && (segmentKey === null || hinted.key === segmentKey)) return hinted.ordinal;
  if (segmentKey !== null) {
    const byKey = plan.find((segment) => segment.key === segmentKey);
    if (byKey) return byKey.ordinal;
  }
  if (hinted) return hinted.ordinal;
  // Plans are ordered by ordinal; clamp to the nearest segment at or after it.
  return (plan.find((segment) => segment.ordinal >= segmentOrdinal) ?? plan[plan.length - 1]).ordinal;
}

/**
 * Validates a client-supplied position. A new write always names the segment
 * key; only converted legacy rows lack one.
 */
export function parseReadingPositionInput(
  value: unknown,
): (ReadingPosition & { segmentKey: string }) | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const key = typeof record.segmentKey === 'string' ? record.segmentKey.trim() : '';
  if (!key || key.length > READING_POSITION_SEGMENT_KEY_MAX_LENGTH) return null;
  const ordinal = record.segmentOrdinal;
  if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 0) return null;
  return { segmentKey: key, segmentOrdinal: ordinal };
}

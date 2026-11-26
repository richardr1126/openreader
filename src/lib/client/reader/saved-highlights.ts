'use client';

import { paintRangeHighlights } from '@/lib/client/highlight-range-painter';
import { rangeForOrdinalsInUnit, type SeekCandidate } from '@/lib/client/reader/segment-hit';
import type { ResolvedHighlight } from '@/lib/client/reader/bookmarks';

/** The highlight name every reader paints saved highlights under. */
export const SAVED_HIGHLIGHT = 'openreader-saved-highlight';

/** A rendered unit (an HTML block, a PDF block's spans, an EPUB sentence) and its plan sentences. */
export type HighlightUnit = {
  roots: readonly Node[];
  candidates: readonly SeekCandidate[];
};

/**
 * Paint saved highlights in `doc` across the given rendered units, below the
 * narration layers, replacing what was painted there before.
 */
export function paintSavedHighlights(
  doc: Document,
  units: Iterable<HighlightUnit>,
  highlights: readonly ResolvedHighlight[],
  declarations: string,
  language?: string,
): void {
  const ranges: Range[] = [];
  if (highlights.length > 0) {
    for (const unit of units) {
      const { candidates } = unit;
      if (candidates.length === 0 || unit.roots.length === 0) continue;
      const first = candidates[0].ordinal;
      const last = candidates[candidates.length - 1].ordinal;
      for (const entry of highlights) {
        if (entry.start > last || entry.end < first) continue;
        const range = rangeForOrdinalsInUnit(unit.roots, candidates, entry.start, entry.end, language);
        if (range) ranges.push(range);
      }
    }
  }
  paintRangeHighlights(doc, SAVED_HIGHLIGHT, ranges, declarations, -1);
}

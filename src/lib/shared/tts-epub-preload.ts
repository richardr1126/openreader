import type { CanonicalTtsSourceUnit } from '@/lib/shared/tts-segment-plan';
import { normalizeEpubLocationToken } from '@/lib/shared/tts-locator';

export interface EpubWalkerLocationItem {
  cfi: string;
}

/**
 * Keep the EPUB depth contract explicit:
 * - `maxDepth` counts the current location as depth 1
 * - upcoming preload targets are therefore `maxDepth - 1`
 */
export function selectUpcomingWalkerItems<T extends EpubWalkerLocationItem>(
  locationItems: readonly T[],
  currentCfi: string,
  maxDepth: number,
): T[] {
  const currentToken = normalizeEpubLocationToken(String(currentCfi || ''));
  const filtered = locationItems.filter((item) =>
    normalizeEpubLocationToken(item.cfi) !== currentToken,
  );
  const targetDepth = Math.max(0, maxDepth - 1);
  return filtered.slice(0, targetDepth);
}

/**
 * Build the canonical source-unit list used for walker-based EPUB planning.
 * When smart splitting is enabled we seed with live context units
 * (previous/current) so walker boundary behavior aligns with setText.
 */
export function buildWalkerPlanningSourceUnits(
  smartSentenceSplitting: boolean,
  contextUnits: readonly CanonicalTtsSourceUnit[],
  upcomingUnits: readonly CanonicalTtsSourceUnit[],
): CanonicalTtsSourceUnit[] {
  if (!smartSentenceSplitting) return [...upcomingUnits];
  return [...contextUnits, ...upcomingUnits];
}

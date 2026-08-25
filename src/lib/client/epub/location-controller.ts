export type EpubLocation = string | number;
export type EpubLocationChangeIntent = 'manual' | 'playback-follow';
export type EpubPlacementIntent = 'initial' | 'renderer' | 'manual' | 'playback-follow';

export function shouldPreserveEpubPlaybackCursor(intent: EpubPlacementIntent): boolean {
  return intent === 'renderer' || intent === 'playback-follow';
}

export function isCfiWithinRenderedRange(
  targetCfi: string,
  startCfi: string | undefined,
  endCfi: string | undefined,
  compare: (left: string, right: string) => number,
): boolean {
  if (!startCfi || !endCfi) return false;
  try {
    return compare(targetCfi, startCfi) >= 0
      && compare(targetCfi, endCfi) <= 0;
  } catch {
    return false;
  }
}

export function isDirectionalEpubLocation(location: EpubLocation): location is 'next' | 'prev' {
  return location === 'next' || location === 'prev';
}

export function shouldNavigateToDifferentCfi(
  location: EpubLocation,
  currentStartCfi: string | undefined,
): location is string {
  return typeof location === 'string'
    && !isDirectionalEpubLocation(location)
    && !!currentStartCfi
    && location !== currentStartCfi;
}

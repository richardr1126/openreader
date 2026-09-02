export type EpubLocation = string | number;
export type EpubLocationChangeIntent = 'manual' | 'playback-follow';
export type EpubPlacementIntent = 'initial' | 'renderer' | 'manual' | 'playback-follow';

export type LatestNavigationState<T> = {
  pending: T | null;
  running: boolean;
};

/**
 * Serialize renderer navigation while coalescing unresolved intermediate
 * targets. A target queued during the current display is always applied after
 * that display, so the newest cursor owns the final rendered location.
 */
export async function drainLatestNavigation<T, U>(
  state: LatestNavigationState<T>,
  resolve: (target: T) => Promise<U | null>,
  navigate: (resolved: U, target: T) => Promise<void>,
): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    while (state.pending !== null) {
      const target = state.pending;
      state.pending = null;
      const resolved = await resolve(target);
      if (state.pending) continue;
      if (resolved !== null) await navigate(resolved, target);
    }
  } finally {
    state.running = false;
  }
}

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

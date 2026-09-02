export type EpubPlacementLifecycle = {
  status: 'idle' | 'waiting-plan' | 'placing' | 'ready' | 'empty-plan' | 'failed';
  error: Error | null;
};

export const IDLE_EPUB_PLACEMENT: EpubPlacementLifecycle = { status: 'idle', error: null };

export type EpubCommittedLocation = {
  startCfi: string;
  endCfi: string;
};

export function readEpubCommittedLocation(value: unknown): EpubCommittedLocation | null {
  if (!value || typeof value !== 'object') return null;
  const location = value as {
    start?: { cfi?: unknown };
    end?: { cfi?: unknown };
  };
  const startCfi = location.start?.cfi;
  const endCfi = location.end?.cfi;
  return typeof startCfi === 'string' && startCfi
    && typeof endCfi === 'string' && endCfi
    ? { startCfi, endCfi }
    : null;
}

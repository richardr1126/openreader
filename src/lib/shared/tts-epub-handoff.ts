import { preprocessSentenceForAudio } from '@/lib/shared/nlp';
import type { CanonicalTtsSegment } from '@/lib/shared/tts-segment-plan';

export type CompletedEpubBoundarySegment = {
  key: string;
  fingerprint: string;
  completedAt: number;
};

export type EpubReplaySuppressionAction =
  | { kind: 'none' }
  | { kind: 'skip-to-index'; index: number }
  | { kind: 'pause' };

export const EPUB_BOUNDARY_HANDOFF_MAX_AGE_MS = 2 * 60 * 1000;

export const fingerprintEpubBoundarySegment = (text: string): string =>
  preprocessSentenceForAudio(text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export const completedEpubBoundarySegment = (
  segment: CanonicalTtsSegment | null | undefined,
  now = Date.now(),
): CompletedEpubBoundarySegment | null => {
  if (!segment?.spansSourceBoundary) return null;
  const fingerprint = fingerprintEpubBoundarySegment(segment.text);
  if (!fingerprint) return null;
  return {
    key: segment.key,
    fingerprint,
    completedAt: now,
  };
};

export const resolveEpubBoundaryHandoffStartIndex = (
  segments: CanonicalTtsSegment[],
  completed: CompletedEpubBoundarySegment | null,
  now = Date.now(),
): number => {
  if (!completed) return 0;
  if (now - completed.completedAt > EPUB_BOUNDARY_HANDOFF_MAX_AGE_MS) return 0;

  let index = 0;
  while (index < segments.length) {
    const segment = segments[index];
    if (segment.key === completed.key) {
      index += 1;
      continue;
    }
    if (fingerprintEpubBoundarySegment(segment.text) === completed.fingerprint) {
      index += 1;
      continue;
    }
    break;
  }

  return index;
};

export const shouldSuppressCompletedEpubBoundaryReplay = (
  segment: CanonicalTtsSegment | null | undefined,
  completed: CompletedEpubBoundarySegment | null,
  now = Date.now(),
): boolean => {
  if (!segment || !completed) return false;
  if (now - completed.completedAt > EPUB_BOUNDARY_HANDOFF_MAX_AGE_MS) return false;
  if (segment.key === completed.key) return true;
  return fingerprintEpubBoundarySegment(segment.text) === completed.fingerprint;
};

export const resolveEpubReplaySuppressionAction = (
  segments: CanonicalTtsSegment[],
  currentIndex: number,
  completed: CompletedEpubBoundarySegment | null,
  now = Date.now(),
): EpubReplaySuppressionAction => {
  if (!shouldSuppressCompletedEpubBoundaryReplay(segments[currentIndex], completed, now)) {
    return { kind: 'none' };
  }

  let nextIndex = currentIndex + 1;
  while (
    nextIndex < segments.length
    && shouldSuppressCompletedEpubBoundaryReplay(segments[nextIndex], completed, now)
  ) {
    nextIndex += 1;
  }

  if (nextIndex < segments.length) {
    return { kind: 'skip-to-index', index: nextIndex };
  }

  return { kind: 'pause' };
};

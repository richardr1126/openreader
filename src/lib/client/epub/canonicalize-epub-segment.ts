import { planSpineSegments } from '@/lib/client/epub/epub-canonical-window';
import {
  normalizeSegmentIdentityText,
  type CanonicalTtsSegment,
} from '@/lib/shared/tts-segment-plan';
import type { TTSSegmentLocator } from '@/types/client';

export interface CanonicalizeEpubSegmentInput {
  segmentText: string;
  spineText: string;
  spineHref: string;
  spineIndex: number;
  hintCharOffset?: number;
  cfi?: string;
  keyPrefix?: string;
  maxBlockLength?: number;
  language?: string;
}

export interface CanonicalizedEpubSegment {
  text: string;
  segmentKey: string;
  segmentIndex: number;
  locator: TTSSegmentLocator;
}

export interface CanonicalizeEpubSegmentsInput extends Omit<CanonicalizeEpubSegmentInput, 'segmentText' | 'hintCharOffset'> {
  segmentTexts: readonly string[];
  hintCharOffsets?: readonly number[];
}

function distanceToHint(segment: CanonicalTtsSegment, hint: number): number {
  return Math.abs(segment.startAnchor.offset - hint);
}

function chooseClosestByHint(
  segments: CanonicalTtsSegment[],
  hint: number,
): CanonicalTtsSegment | null {
  if (segments.length === 0) return null;
  return segments
    .slice()
    .sort((a, b) => {
      const byDistance = distanceToHint(a, hint) - distanceToHint(b, hint);
      if (byDistance !== 0) return byDistance;
      return a.ordinal - b.ordinal;
    })[0] ?? null;
}

function chooseByHintWindow(
  segments: CanonicalTtsSegment[],
  hint: number,
): CanonicalTtsSegment | null {
  if (segments.length === 0) return null;

  const containing = segments.filter((segment) =>
    hint >= segment.startAnchor.offset && hint < segment.endAnchor.offset,
  );
  if (containing.length > 0) return chooseClosestByHint(containing, hint);

  const forward = segments.filter((segment) => segment.startAnchor.offset >= hint);
  if (forward.length > 0) {
    return forward
      .slice()
      .sort((a, b) => {
        const byStart = a.startAnchor.offset - b.startAnchor.offset;
        if (byStart !== 0) return byStart;
        return a.ordinal - b.ordinal;
      })[0] ?? null;
  }

  // Fallback: everything is before the hint; choose nearest by distance.
  return chooseClosestByHint(segments, hint);
}

function buildCanonicalPlan(input: Omit<CanonicalizeEpubSegmentInput, 'segmentText' | 'hintCharOffset'>): CanonicalTtsSegment[] {
  return planSpineSegments({
    spineText: input.spineText,
    spineHref: input.spineHref,
    spineIndex: input.spineIndex,
    keyPrefix: input.keyPrefix,
    maxBlockLength: input.maxBlockLength,
    language: input.language,
  });
}

function toCanonicalized(
  chosen: CanonicalTtsSegment,
  input: Omit<CanonicalizeEpubSegmentInput, 'segmentText' | 'hintCharOffset'>,
): CanonicalizedEpubSegment {
  const locator: TTSSegmentLocator = {
    readerType: 'epub',
    spineHref: input.spineHref,
    spineIndex: input.spineIndex,
    charOffset: Math.max(0, chosen.startAnchor.offset),
  };
  if (input.cfi) locator.cfi = input.cfi;

  return {
    text: chosen.text,
    segmentKey: chosen.key,
    segmentIndex: chosen.ordinal,
    locator,
  };
}

/**
 * Canonicalize a possibly viewport-shaped EPUB segment candidate against one
 * spine item's full text. Prefers exact normalized-text matches near the hint
 * offset; falls back to hint-window selection when boundaries differ.
 */
export function canonicalizeEpubSegmentAgainstSpineText(
  input: CanonicalizeEpubSegmentInput,
): CanonicalizedEpubSegment | null {
  if (!input.segmentText.trim()) {
    return null;
  }
  const segments = buildCanonicalPlan(input);
  if (segments.length === 0) return null;

  const normalizedCandidate = normalizeSegmentIdentityText(input.segmentText);
  const hint = Math.max(0, Math.floor(input.hintCharOffset ?? 0));
  const exactMatches = segments.filter((segment) =>
    normalizeSegmentIdentityText(segment.text) === normalizedCandidate,
  );

  const chosen = chooseClosestByHint(exactMatches, hint)
    ?? chooseByHintWindow(segments, hint);
  if (!chosen) return null;

  return toCanonicalized(chosen, input);
}

/**
 * Canonicalize a sentence list against one spine item's full text with a
 * monotonic (forward-only) segment ordinal cursor. This prevents overlap
 * boundary rows from snapping backward to an earlier canonical segment when a
 * local boundary split changes sentence text.
 */
export function canonicalizeEpubSegmentsAgainstSpineText(
  input: CanonicalizeEpubSegmentsInput,
): Array<CanonicalizedEpubSegment | null> {
  const output: Array<CanonicalizedEpubSegment | null> = input.segmentTexts.map(() => null);
  const segments = buildCanonicalPlan(input);
  if (segments.length === 0) return output;

  let nextMinOrdinal = 0;
  for (let i = 0; i < input.segmentTexts.length; i += 1) {
    const rawText = input.segmentTexts[i] ?? '';
    if (!rawText.trim()) continue;
    const hint = Math.max(0, Math.floor(input.hintCharOffsets?.[i] ?? 0));
    const allowed = segments.filter((segment) => segment.ordinal >= nextMinOrdinal);
    if (allowed.length === 0) break;

    const normalizedCandidate = normalizeSegmentIdentityText(rawText);
    const exactMatches = allowed.filter((segment) =>
      normalizeSegmentIdentityText(segment.text) === normalizedCandidate,
    );
    const chosen = chooseClosestByHint(exactMatches, hint)
      ?? chooseByHintWindow(allowed, hint);
    if (!chosen) continue;

    output[i] = toCanonicalized(chosen, input);
    nextMinOrdinal = chosen.ordinal + 1;
  }

  return output;
}

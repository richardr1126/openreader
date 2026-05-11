import { preprocessSentenceForAudio, splitTextToTtsBlocks, splitTextToTtsBlocksEPUB } from '@/lib/shared/nlp';
import type { TTSSegmentLocator } from '@/types/client';
import type { ReaderType } from '@/types/user-state';

export const TTS_SEGMENT_PLAN_VERSION = 'tts-segment-plan-v1';

export interface CanonicalTtsSourceUnit {
  sourceKey: string;
  text: string;
  locator?: TTSSegmentLocator | null;
}

export interface CanonicalTtsAnchor {
  sourceKey: string;
  offset: number;
}

export interface CanonicalTtsSegment {
  key: string;
  ordinal: number;
  text: string;
  ownerSourceKey: string;
  ownerLocator: TTSSegmentLocator | null;
  startAnchor: CanonicalTtsAnchor;
  endAnchor: CanonicalTtsAnchor;
  spansSourceBoundary: boolean;
}

export interface CanonicalTtsSegmentPlan {
  version: string;
  readerType: ReaderType;
  text: string;
  segments: CanonicalTtsSegment[];
}

export interface CanonicalTtsSegmentPlanOptions {
  readerType?: ReaderType;
  maxBlockLength?: number;
  keyPrefix?: string;
}

interface PreparedSourceUnit {
  sourceKey: string;
  text: string;
  locator: TTSSegmentLocator | null;
  startOffset: number;
  endOffset: number;
}

interface NormalizedTextMap {
  text: string;
  rawByNormalizedIndex: number[];
}

const normalizeSourceText = (text: string): string =>
  preprocessSentenceForAudio(text)
    .replace(/\s+/g, ' ')
    .trim();

const normalizeSegmentIdentityText = (text: string): string =>
  preprocessSentenceForAudio(text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const stableHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const buildSegmentKey = (keyPrefix: string, text: string): string =>
  [
    keyPrefix,
    stableHash(normalizeSegmentIdentityText(text)),
  ].join(':');

const normalizeWithRawMap = (text: string): NormalizedTextMap => {
  let normalized = '';
  const rawByNormalizedIndex: number[] = [];
  let pendingWhitespaceIndex: number | null = null;

  const flushWhitespace = () => {
    if (pendingWhitespaceIndex === null || normalized.length === 0 || normalized.endsWith(' ')) {
      pendingWhitespaceIndex = null;
      return;
    }
    normalized += ' ';
    rawByNormalizedIndex.push(pendingWhitespaceIndex);
    pendingWhitespaceIndex = null;
  };

  for (let rawIndex = 0; rawIndex < text.length; rawIndex += 1) {
    const char = text[rawIndex];
    if (/\s/.test(char)) {
      if (pendingWhitespaceIndex === null) pendingWhitespaceIndex = rawIndex;
      continue;
    }

    flushWhitespace();
    normalized += char;
    rawByNormalizedIndex.push(rawIndex);
  }

  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1);
    rawByNormalizedIndex.pop();
  }

  return { text: normalized, rawByNormalizedIndex };
};

const findFlexibleOffset = (
  haystack: string,
  needle: string,
  fromNormalizedIndex: number,
): { start: number; end: number; normalizedEnd: number } | null => {
  const normalizedHaystack = normalizeWithRawMap(haystack);
  const normalizedNeedle = normalizeWithRawMap(needle).text;
  if (!normalizedNeedle) return null;

  const safeFrom = Math.max(0, Math.min(fromNormalizedIndex, normalizedHaystack.text.length));
  const normalizedStart = normalizedHaystack.text.indexOf(normalizedNeedle, safeFrom);
  if (normalizedStart < 0) return null;

  const normalizedEnd = normalizedStart + normalizedNeedle.length;
  const rawStart = normalizedHaystack.rawByNormalizedIndex[normalizedStart];
  const rawEndLast = normalizedHaystack.rawByNormalizedIndex[normalizedEnd - 1];
  if (rawStart === undefined || rawEndLast === undefined) return null;

  return {
    start: rawStart,
    end: rawEndLast + 1,
    normalizedEnd,
  };
};

const findSourceForOffset = (
  sources: PreparedSourceUnit[],
  offset: number,
  bias: 'start' | 'end',
): PreparedSourceUnit | null => {
  if (sources.length === 0) return null;
  const clamped = Math.max(0, offset);

  const containing = sources.find((source) =>
    bias === 'start'
      ? clamped >= source.startOffset && clamped < source.endOffset
      : clamped > source.startOffset && clamped <= source.endOffset,
  );
  if (containing) return containing;

  if (bias === 'start') {
    return sources.find((source) => clamped < source.startOffset) ?? sources[sources.length - 1];
  }

  for (let i = sources.length - 1; i >= 0; i -= 1) {
    if (clamped > sources[i].endOffset) return sources[i];
  }
  return sources[0];
};

const anchorForOffset = (
  source: PreparedSourceUnit,
  offset: number,
): CanonicalTtsAnchor => ({
  sourceKey: source.sourceKey,
  offset: Math.max(0, Math.min(offset - source.startOffset, source.text.length)),
});

export function planCanonicalTtsSegments(
  sourceUnits: CanonicalTtsSourceUnit[],
  options: CanonicalTtsSegmentPlanOptions = {},
): CanonicalTtsSegmentPlan {
  const readerType = options.readerType ?? 'pdf';
  const keyPrefix = options.keyPrefix ?? TTS_SEGMENT_PLAN_VERSION;
  const preparedSources: PreparedSourceUnit[] = [];
  const textParts: string[] = [];
  let combinedLength = 0;

  for (const sourceUnit of sourceUnits) {
    const text = normalizeSourceText(sourceUnit.text);
    if (!text) continue;

    if (textParts.length > 0) {
      textParts.push(' ');
      combinedLength += 1;
    }

    const startOffset = combinedLength;
    textParts.push(text);
    combinedLength += text.length;
    preparedSources.push({
      sourceKey: sourceUnit.sourceKey,
      text,
      locator: sourceUnit.locator ?? null,
      startOffset,
      endOffset: combinedLength,
    });
  }

  const canonicalText = textParts.join('');
  const splitOptions = { maxBlockLength: options.maxBlockLength };
  const blocks = readerType === 'epub'
    ? splitTextToTtsBlocksEPUB(canonicalText, splitOptions)
    : splitTextToTtsBlocks(canonicalText, splitOptions);

  let rawCursor = 0;
  let normalizedCursor = 0;
  const segments: CanonicalTtsSegment[] = [];

  for (const block of blocks) {
    const text = block.trim();
    if (!text) continue;

    const exactStart = canonicalText.indexOf(text, rawCursor);
    let startOffset: number;
    let endOffset: number;

    if (exactStart >= 0) {
      startOffset = exactStart;
      endOffset = exactStart + text.length;
      rawCursor = endOffset;
      normalizedCursor = normalizeWithRawMap(canonicalText.slice(0, endOffset)).text.length;
    } else {
      const flexible = findFlexibleOffset(canonicalText, text, normalizedCursor);
      if (!flexible) continue;
      startOffset = flexible.start;
      endOffset = flexible.end;
      rawCursor = endOffset;
      normalizedCursor = flexible.normalizedEnd;
    }

    const ownerSource = findSourceForOffset(preparedSources, startOffset, 'start');
    const endSource = findSourceForOffset(preparedSources, Math.max(startOffset, endOffset - 1), 'end');
    if (!ownerSource || !endSource) continue;

    if (ownerSource.sourceKey === endSource.sourceKey) {
      // Block falls entirely within a single source — emit as-is.
      const ordinal = segments.length;
      const startAnchor = anchorForOffset(ownerSource, startOffset);
      const endAnchor = anchorForOffset(endSource, endOffset);
      segments.push({
        key: buildSegmentKey(keyPrefix, text),
        ordinal,
        text,
        ownerSourceKey: ownerSource.sourceKey,
        ownerLocator: ownerSource.locator,
        startAnchor,
        endAnchor,
        spansSourceBoundary: false,
      });
    } else {
      // Block spans one or more source boundaries. Decide whether to keep it
      // as a single boundary-spanning segment or to split it at each boundary.
      //
      // When all involved sources carry locators (e.g. current page → next
      // page for PDF), we keep the unified boundary-spanning segment so that
      // features like the PDF page-turn estimate and EPUB boundary handoff
      // continue to work.
      //
      // When the block starts in a context-only source (locator === null),
      // we need to handle two sub-cases:
      //
      //   a) Clean boundary — the context portion ends at a sentence boundary
      //      (e.g. ends with ".!?"). In this case, each source's portion is a
      //      complete sentence; split the block so neither source absorbs the
      //      other's text.
      //
      //   b) Overlapping sentence — the sentence genuinely spans from the
      //      context source into the real source. Keep the block unified and
      //      owned by the context-only source. The overlapping sentence was
      //      already played on the previous page via forward-looking
      //      continuation, so it should be filtered out of the current page's
      //      segments.
      if (ownerSource.locator !== null) {
        // Both sources carry locators → original unified boundary behavior.
        const ordinal = segments.length;
        const startAnchor = anchorForOffset(ownerSource, startOffset);
        const endAnchor = anchorForOffset(endSource, endOffset);
        segments.push({
          key: buildSegmentKey(keyPrefix, text),
          ordinal,
          text,
          ownerSourceKey: ownerSource.sourceKey,
          ownerLocator: ownerSource.locator,
          startAnchor,
          endAnchor,
          spansSourceBoundary: true,
        });
      } else {
        // Owner is context-only. Find the first real source in this span.
        const ownerIdx = preparedSources.indexOf(ownerSource);
        const endIdx = preparedSources.indexOf(endSource);
        let firstRealIdx = ownerIdx;
        for (let i = ownerIdx; i <= endIdx; i += 1) {
          if (preparedSources[i].locator !== null) { firstRealIdx = i; break; }
        }

        // Check whether the context portion ends at a natural sentence
        // boundary by looking at the trimmed text up to the source boundary.
        const contextEnd = preparedSources[firstRealIdx].startOffset;
        const contextPortion = canonicalText.slice(startOffset, contextEnd).trim();
        const isCleanBoundary = contextPortion.length > 0
          && /[.!?]["'""'')\]]*\s*$/.test(contextPortion);

        if (isCleanBoundary) {
          // Clean boundary → split at each source boundary.
          let subStart = startOffset;
          for (let srcIdx = ownerIdx; srcIdx <= endIdx; srcIdx += 1) {
            const source = preparedSources[srcIdx];
            const subEnd = srcIdx < endIdx ? source.endOffset : endOffset;
            if (subEnd <= subStart) continue;

            const subText = canonicalText.slice(subStart, subEnd).trim();
            if (!subText) {
              subStart = subEnd;
              continue;
            }

            const nextSource = srcIdx < endIdx ? preparedSources[srcIdx + 1] : null;
            const subStartAnchor = anchorForOffset(source, subStart);
            const subEndAnchor = anchorForOffset(source, subEnd);
            const ordinal = segments.length;
            segments.push({
              key: buildSegmentKey(keyPrefix, subText),
              ordinal,
              text: subText,
              ownerSourceKey: source.sourceKey,
              ownerLocator: source.locator,
              startAnchor: subStartAnchor,
              endAnchor: subEndAnchor,
              spansSourceBoundary: false,
            });
            subStart = nextSource ? nextSource.startOffset : subEnd;
          }
        } else {
          // Overlapping sentence → keep unified, owned by the context-only
          // source. This segment will be filtered out of the current page's
          // segments since the context source has no locator and a different
          // sourceKey. The sentence was already played on the previous page.
          const ordinal = segments.length;
          const startAnchor = anchorForOffset(ownerSource, startOffset);
          const endAnchor = anchorForOffset(endSource, endOffset);
          segments.push({
            key: buildSegmentKey(keyPrefix, text),
            ordinal,
            text,
            ownerSourceKey: ownerSource.sourceKey,
            ownerLocator: ownerSource.locator,
            startAnchor,
            endAnchor,
            spansSourceBoundary: true,
          });
        }
      }
    }
  }

  return {
    version: TTS_SEGMENT_PLAN_VERSION,
    readerType,
    text: canonicalText,
    segments,
  };
}

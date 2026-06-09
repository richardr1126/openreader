import { describe, expect, test } from 'vitest';

import { locateAlignmentWordSpans } from '../../src/lib/client/highlight-token-alignment';

const words = (...texts: string[]) =>
  texts.map((text) => ({ text, startSec: 0, endSec: 0, charStart: 0, charEnd: 0 }));

// Extract the highlighted substring for a span (or null) so assertions read in
// terms of what the user would actually see highlighted.
const slice = (region: string, span: { start: number; end: number } | null): string | null =>
  span ? region.slice(span.start, span.end) : null;

describe('locateAlignmentWordSpans', () => {
  test('maps each word to its own span when the region has separators (TXT)', () => {
    const region = 'The quick brown fox';
    const spans = locateAlignmentWordSpans(words('The', 'quick', 'brown', 'fox'), region);

    expect(spans.map((s) => slice(region, s))).toEqual(['The', 'quick', 'brown', 'fox']);
  });

  test('degrades gracefully when inline DOM concatenated two words (MD)', () => {
    // "The <strong>quick</strong> brown fox" with the inter-word space dropped
    // at the node boundary collapses into a single "Thequick" token. Both words
    // must still highlight (the merged region), and crucially NOTHING is null —
    // no "nothing highlights", no "random word".
    const region = 'Thequick brown fox';
    const spans = locateAlignmentWordSpans(words('The', 'quick', 'brown', 'fox'), region);

    expect(spans.every((s) => s !== null)).toBe(true);
    expect(slice(region, spans[0])).toBe('Thequick');
    expect(slice(region, spans[1])).toBe('Thequick');
    expect(slice(region, spans[2])).toBe('brown');
    expect(slice(region, spans[3])).toBe('fox');
  });

  test('tolerates punctuation/quote divergence between spoken words and region', () => {
    const region = '“Hello,” she said';
    const spans = locateAlignmentWordSpans(words('hello', 'she', 'said'), region);

    expect(slice(region, spans[0])).toBe('Hello');
    expect(slice(region, spans[1])).toBe('she');
    expect(slice(region, spans[2])).toBe('said');
  });

  test('fillGaps: a word absent from the region inherits a neighbor (never null)', () => {
    // Whisper emitted "beta" but it is not in the rendered text. It must not
    // leave a hole — fillGaps borrows the neighboring token so the highlight
    // keeps moving instead of disappearing.
    const region = 'alpha gamma delta';
    const spans = locateAlignmentWordSpans(words('alpha', 'beta', 'gamma', 'delta'), region);

    expect(spans.every((s) => s !== null)).toBe(true);
    expect(slice(region, spans[0])).toBe('alpha');
    expect(slice(region, spans[2])).toBe('gamma');
    expect(slice(region, spans[3])).toBe('delta');
    // The orphan word borrows a neighbor rather than vanishing.
    expect(['alpha', 'gamma']).toContain(slice(region, spans[1]));
  });

  test('is monotonic across repeated words (second "the" resolves later)', () => {
    const region = 'the cat the dog';
    const spans = locateAlignmentWordSpans(words('the', 'cat', 'the', 'dog'), region);

    expect(spans[0]).toEqual({ start: 0, end: 3 });
    expect(spans[2]).toEqual({ start: 8, end: 11 });
    expect(spans[3]).toEqual({ start: 12, end: 15 });
  });

  test('returns all-null for an empty region and empty for no words', () => {
    expect(locateAlignmentWordSpans(words('a', 'b'), '')).toEqual([null, null]);
    expect(locateAlignmentWordSpans([], 'anything')).toEqual([]);
  });
});

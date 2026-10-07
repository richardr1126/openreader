import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  collectTextTokens,
  createTapGuard,
  indexSegmentsBySource,
  pickSegmentForToken,
  tokenIndexAtCaret,
} from '@/lib/client/reader/segment-hit';

const words = (text: string) => text.split(/\s+/).filter(Boolean);

describe('pickSegmentForToken', () => {
  const candidates = [
    { ordinal: 7, text: 'Dorothy lived in Kansas.' },
    { ordinal: 8, text: 'Aunt Em was afraid.' },
    { ordinal: 9, text: 'Toto barked.' },
  ];
  const unit = words('Dorothy lived in Kansas. Aunt Em was afraid. Toto barked.');

  it('returns the sentence containing the tapped word and its token window', () => {
    expect(pickSegmentForToken(candidates, unit, 0)).toEqual({ ordinal: 7, startToken: 0, endToken: 3 });
    expect(pickSegmentForToken(candidates, unit, 5)).toEqual({ ordinal: 8, startToken: 4, endToken: 7 });
    expect(pickSegmentForToken(candidates, unit, 9)).toEqual({ ordinal: 9, startToken: 8, endToken: 9 });
  });

  it('falls back to proportional windows when the rendered words diverge', () => {
    const hyphenated = words('Doro- thy lived in Kansas. Aunt Em was afraid. Toto barked.');
    expect(pickSegmentForToken(candidates, hyphenated, 1)?.ordinal).toBe(7);
    expect(pickSegmentForToken(candidates, hyphenated, 10)?.ordinal).toBe(9);
  });

  it('places sentences that cross a source boundary by their visible part', () => {
    const index = indexSegmentsBySource([
      { ordinal: 1, text: 'It began here and', startAnchor: { sourceKey: 'a' }, endAnchor: { sourceKey: 'b' } },
      { ordinal: 2, text: 'Next one.', startAnchor: { sourceKey: 'b' }, endAnchor: { sourceKey: 'b' } },
      { ordinal: 3, text: 'Last starts', startAnchor: { sourceKey: 'b' }, endAnchor: { sourceKey: 'c' } },
    ]);
    const unitB = index.get('b') ?? [];
    expect(unitB.map((candidate) => [candidate.ordinal, candidate.part])).toEqual([
      [1, 'tail'], [2, undefined], [3, 'head'],
    ]);
    const tokens = words('here and Next one. Last');
    expect(pickSegmentForToken(unitB, tokens, 1)).toEqual({ ordinal: 1, startToken: 0, endToken: 1 });
    expect(pickSegmentForToken(unitB, tokens, 3)).toEqual({ ordinal: 2, startToken: 2, endToken: 3 });
    expect(pickSegmentForToken(unitB, tokens, 4)).toEqual({ ordinal: 3, startToken: 4, endToken: 4 });
  });

  it('takes a single candidate whole and rejects taps outside the unit', () => {
    expect(pickSegmentForToken([candidates[0]], unit, 6)).toEqual({ ordinal: 7, startToken: 0, endToken: 9 });
    expect(pickSegmentForToken(candidates, unit, -1)).toBeNull();
    expect(pickSegmentForToken([], unit, 0)).toBeNull();
  });
});

describe('DOM token helpers', () => {
  it('maps a caret to the word it falls in', () => {
    const { document } = parseHTML('<html><body><p>One two. <em>Three</em> four.</p></body></html>');
    const root = document.querySelector('p') as unknown as Element;
    const tokens = collectTextTokens([root]);
    expect(tokens.map((token) => token.text)).toEqual(['One', 'two', 'Three', 'four']);
    const first = root.firstChild as Text;
    expect(tokenIndexAtCaret(tokens, { node: first, offset: 5 })).toBe(1);
    expect(tokenIndexAtCaret(tokens, { node: first, offset: 3 })).toBe(1);
    expect(tokenIndexAtCaret(tokens, { node: root, offset: 0 })).toBe(-1);
  });
});

describe('createTapGuard', () => {
  const target = (interactive: boolean) => ({
    closest: () => (interactive ? {} : null),
    ownerDocument: null,
  }) as unknown as EventTarget;
  const click = (clientX: number, clientY: number, interactive = false) => ({
    button: 0, clientX, clientY, defaultPrevented: false,
    metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    target: target(interactive),
  });

  it('accepts a still click on text and rejects drags and links', () => {
    const guard = createTapGuard();
    guard.pointerDown({ clientX: 10, clientY: 10, button: 0 });
    expect(guard.isTap(click(12, 11))).toBe(true);

    guard.pointerDown({ clientX: 10, clientY: 10, button: 0 });
    expect(guard.isTap(click(60, 10))).toBe(false);

    guard.pointerDown({ clientX: 10, clientY: 10, button: 0 });
    expect(guard.isTap(click(10, 10, true))).toBe(false);
  });
});

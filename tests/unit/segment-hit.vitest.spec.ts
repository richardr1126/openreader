import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  collectTextTokens,
  createTapGuard,
  indexSegmentsBySource,
  pickSegmentForToken,
  segmentSourceKey,
  tokenIndexAtCaret,
} from '@/lib/client/reader/segment-hit';
import { normalizePlaybackPlan, playbackPlanToCanonicalSegments } from '@/lib/shared/playback-plan';

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

  it('indexes the client plan by the rendered PDF block or HTML anchor', () => {
    // The real client shape: anchors carry segment keys, only locators name the unit.
    const segments = playbackPlanToCanonicalSegments(normalizePlaybackPlan({
      segments: [
        { ordinal: 0, segmentKey: 'doc:pdf:v1:aaa', text: 'Chapter One', locator: { readerType: 'pdf', page: 1, blockId: 'p1-b0' } },
        { ordinal: 1, segmentKey: 'doc:pdf:v1:bbb', text: 'First.', locator: { readerType: 'pdf', page: 1, blockId: 'p1-b1' } },
        { ordinal: 2, segmentKey: 'doc:pdf:v1:ccc', text: 'Second.', locator: { readerType: 'pdf', page: 1, blockId: 'p1-b1' } },
        { ordinal: 3, segmentKey: 'doc:html:v1:ddd', text: 'Heading', locator: { readerType: 'html', location: 'b-0002' } },
        { ordinal: 4, segmentKey: 'doc:epub:v1:eee', text: 'Spine.', locator: { readerType: 'epub', spineHref: 'a.xhtml', spineIndex: 0, charOffset: 0 } },
      ],
    }));
    const index = indexSegmentsBySource(segments);
    expect([...index.keys()]).toEqual(['pdf:1:p1-b0', 'pdf:1:p1-b1', 'b-0002', 'segment:4']);
    expect(index.get('pdf:1:p1-b1')?.map((candidate) => candidate.ordinal)).toEqual([1, 2]);
    expect(segmentSourceKey(segments[3])).toBe('b-0002');
  });

  it('resolves a sentence continuing into the next unit proportionally', () => {
    const tokens = words('Next one. Last starts');
    const unit = [
      { ordinal: 2, text: 'Next one.' },
      { ordinal: 3, text: 'Last starts here and runs on' },
    ];
    expect(pickSegmentForToken(unit, tokens, 0)?.ordinal).toBe(2);
    expect(pickSegmentForToken(unit, tokens, 3)?.ordinal).toBe(3);
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

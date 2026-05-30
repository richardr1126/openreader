import { describe, expect, test } from 'vitest';
import type { Book } from 'epubjs';
import {
  buildEpubLocator,
  buildEpubLocatorFromChunk,
  findSegmentOffset,
  getSpineItemPlainText,
  invalidateSpinePlainTextCache,
  resolveMonotonicSentenceOffsets,
  resolveSpineFromCfi,
} from '../../src/lib/client/epub/spine-coordinates';
import { isStableEpubLocator } from '../../src/types/client';

interface FakeSection {
  index: number;
  href: string;
  cfiBase: string;
  __text: string;
  // epubjs's real `section.load()` resolves to an `<html>` Element, but
  // historically the fake returned a Document. We accept both so the helper's
  // defensive shape-handling can be tested.
  load: (request?: unknown) => Promise<Element | Document>;
  unload: () => void;
}

function makeFakeBook(items: Array<{ index: number; href: string; cfiBase: string; text: string }>) {
  // Mirror what epubjs's `Section.load()` actually does: resolve to the
  // spine item's `<html>` Element (NOT a Document). The helper has to query
  // `<body>` inside it — that's the contract this test fixture pins down.
  const sections: FakeSection[] = items.map((item) => ({
    index: item.index,
    href: item.href,
    cfiBase: item.cfiBase,
    __text: item.text,
    load: async () => {
      if (typeof document === 'undefined') {
        // Node fallback: hand back a shape with a `body` getter so the
        // helper's body-aware branch still works.
        return {
          querySelector: (sel: string) => (sel === 'body' ? { textContent: item.text } : null),
          textContent: item.text,
        } as unknown as Element;
      }
      const html = document.createElement('html');
      const body = document.createElement('body');
      body.textContent = item.text;
      html.appendChild(body);
      return html as unknown as Document;
    },
    unload: () => {},
  }));

  const get = (target: unknown) => {
    if (typeof target === 'number') {
      return sections.find((s) => s.index === target) ?? null;
    }
    if (typeof target === 'string') {
      // Match by href substring or by cfiBase substring (epubcfi(/6/4!...) → '/6/4').
      const byHref = sections.find((s) => s.href === target || target.includes(s.href));
      if (byHref) return byHref;
      const byCfiBase = sections.find((s) => target.includes(s.cfiBase));
      if (byCfiBase) return byCfiBase;
    }
    return null;
  };

  const book = {
    spine: { get, spineItems: sections },
    load: () => Promise.resolve(undefined),
  } as unknown as Book;
  return { book, sections };
}

describe('findSegmentOffset', () => {
  test('finds an offset for matching text', () => {
    const spineText = 'Hello world. This is a test paragraph for offsets.';
    const offset = findSegmentOffset(spineText, 'this is a test');
    expect(offset).toBeGreaterThanOrEqual(0);
  });

  test('uses the hint to disambiguate repeated phrases', () => {
    const spineText = 'apple banana apple banana apple banana';
    // First occurrence
    const first = findSegmentOffset(spineText, 'apple banana', 0);
    // Hint past the first occurrence
    const second = findSegmentOffset(spineText, 'apple banana', first + 1);
    expect(second).toBeGreaterThan(first);
  });

  test('returns -1 when the segment text is not present', () => {
    expect(findSegmentOffset('hello world', 'goodbye')).toBe(-1);
  });

  test('falls back to a from-start search when the hint overshoots', () => {
    const spineText = 'apple banana cherry';
    const offset = findSegmentOffset(spineText, 'apple', 100);
    expect(offset).toBe(0);
  });
});

describe('resolveSpineFromCfi', () => {
  test('returns spine identity for a CFI inside a known spine', () => {
    const { book } = makeFakeBook([
      { index: 2, href: 'OEBPS/ch02.xhtml', cfiBase: '/6/4', text: 'chapter 2 contents' },
      { index: 3, href: 'OEBPS/ch03.xhtml', cfiBase: '/6/6', text: 'chapter 3 contents' },
    ]);
    const resolved = resolveSpineFromCfi(book, 'epubcfi(/6/4!/4:0)');
    expect(resolved).toEqual({ href: 'OEBPS/ch02.xhtml', index: 2 });
  });

  test('returns null when the spine.get call throws', () => {
    const broken = {
      spine: {
        get: () => { throw new Error('boom'); },
        spineItems: [],
      },
    } as unknown as Book;
    expect(resolveSpineFromCfi(broken, 'epubcfi(/6/4!/4:0)')).toBeNull();
  });

  test('returns null for null/undefined input', () => {
    const { book } = makeFakeBook([]);
    expect(resolveSpineFromCfi(book, null)).toBeNull();
    expect(resolveSpineFromCfi(book, undefined)).toBeNull();
  });
});

describe('buildEpubLocator', () => {
  test('produces a stable locator with charOffset within the spine item', async () => {
    const { book } = makeFakeBook([
      {
        index: 2,
        href: 'OEBPS/ch02.xhtml',
        cfiBase: '/6/4',
        text: 'First paragraph. The quick brown fox jumps over the lazy dog. Final words here.',
      },
    ]);

    invalidateSpinePlainTextCache(book);
    const locator = await buildEpubLocator(
      book,
      'epubcfi(/6/4!/4:0)',
      'The quick brown fox',
    );

    expect(locator).not.toBeNull();
    expect(isStableEpubLocator(locator)).toBe(true);
    if (!locator || !isStableEpubLocator(locator)) return; // narrow for TS
    expect(locator.spineHref).toBe('OEBPS/ch02.xhtml');
    expect(locator.spineIndex).toBe(2);
    expect(locator.charOffset).toBeGreaterThan(0);
    expect(locator.cfi).toBe('epubcfi(/6/4!/4:0)');
  });

  test('returns null when the CFI does not resolve to any spine item', async () => {
    const { book } = makeFakeBook([
      { index: 0, href: 'OEBPS/ch00.xhtml', cfiBase: '/6/2', text: 'only chapter' },
    ]);
    const locator = await buildEpubLocator(book, 'epubcfi(/99/99!/4:0)', 'nope');
    expect(locator).toBeNull();
  });

  test('same content text yields identical locators across two calls (stability)', async () => {
    const { book } = makeFakeBook([
      {
        index: 4,
        href: 'OEBPS/ch04.xhtml',
        cfiBase: '/6/8',
        text: 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu.',
      },
    ]);
    const a = await buildEpubLocator(book, 'epubcfi(/6/8!/4:0)', 'gamma delta epsilon');
    const b = await buildEpubLocator(book, 'epubcfi(/6/8!/4:0)', 'gamma delta epsilon');
    expect(a).toEqual(b);
  });
});

describe('buildEpubLocatorFromChunk', () => {
  test('uses the chunk anchor offset as a hint to disambiguate repeated text', () => {
    const spineText = 'foo bar foo bar foo bar';
    const anchorEarly = {
      spineHref: 'a.xhtml',
      spineIndex: 0,
      charOffset: 0,
      spineText,
    };
    const anchorLate = {
      spineHref: 'a.xhtml',
      spineIndex: 0,
      charOffset: 8, // past the first "foo bar"
      spineText,
    };
    const early = buildEpubLocatorFromChunk(anchorEarly, 'foo bar');
    const late = buildEpubLocatorFromChunk(anchorLate, 'foo bar');
    expect(early.charOffset).toBeLessThan(late.charOffset ?? Infinity);
  });

  test('NEVER returns an offset before the chunk anchor (forward-only)', () => {
    // Regression: a segment text that recurs earlier in the chapter must not
    // get persisted with the earlier offset. The forward-only contract is
    // what keeps later-page rows from interleaving with earlier pages in the
    // sidebar's sort.
    const spineText = 'Yes I said. ' + 'Filler. '.repeat(20) + 'Yes I said. The actual page sentence.';
    const earlyOccurrence = spineText.indexOf('Yes I said.');
    const lateOccurrence = spineText.indexOf('Yes I said.', earlyOccurrence + 1);
    expect(earlyOccurrence).toBeLessThan(lateOccurrence); // sanity

    const anchor = {
      spineHref: 'a.xhtml',
      spineIndex: 0,
      // Anchored ~at the actual page (past the early occurrence).
      charOffset: lateOccurrence - 5,
      spineText,
    };
    const locator = buildEpubLocatorFromChunk(anchor, 'Yes I said.');
    expect(locator.charOffset).toBeGreaterThanOrEqual(anchor.charOffset);
    // Specifically: must be at the late occurrence, NOT the early one.
    expect(locator.charOffset).toBeGreaterThan(earlyOccurrence);
  });

  test('holds the anchor offset when segment text is not found ahead', () => {
    const anchor = {
      spineHref: 'a.xhtml',
      spineIndex: 0,
      charOffset: 100,
      spineText: 'short text here',
    };
    const locator = buildEpubLocatorFromChunk(anchor, 'definitely not present');
    expect(locator.charOffset).toBe(100); // holds at anchor, never goes earlier
  });
});

describe('buildEpubLocator anchored-search regression', () => {
  // Pins the contract for the server-side resolver path: when called with
  // a `chunkText` argument representing the current rendered page, the
  // returned locator's `charOffset` is **at or after** the chunk's position
  // in the spine — never the segment's earliest occurrence in the chapter.
  test('locator for a recurring sentence sits at the page anchor, not the chapter-early echo', async () => {
    if (typeof document === 'undefined') return; // DOM-only via fixture
    const earlyEcho = 'The Lighthouse.';
    const pageText = 'On Tuesday, the visitors arrived. The Lighthouse. They marveled at the height.';
    const chapterText = `${earlyEcho} ${'Filler sentence. '.repeat(40)}${pageText}`;
    const { book } = makeFakeBook([
      { index: 0, href: 'ch.xhtml', cfiBase: '/6/2', text: chapterText },
    ]);
    invalidateSpinePlainTextCache(book);
    // Search the SAME segment text. The resolver passes the page text as
    // chunkText, so the anchor sits at the page's start — not at the
    // earlier `earlyEcho` occurrence.
    const locator = await buildEpubLocator(
      book,
      'epubcfi(/6/2!/4:0)',
      'The Lighthouse.',
      pageText,
    );
    expect(locator).not.toBeNull();
    if (!locator || !isStableEpubLocator(locator)) return;
    // The returned offset must be past where the early echo lives.
    const earlyEchoIndex = chapterText.toLowerCase().indexOf(earlyEcho.toLowerCase());
    expect(locator.charOffset).toBeGreaterThan(earlyEchoIndex);
  });
});

describe('findSegmentOffset fallback contract', () => {
  // These tests pin the documented behavior of `findSegmentOffset`. The
  // from-start fallback is correct for single-shot lookups but **wrong** in
  // a monotonic per-sentence walk — `resolveMonotonicSentenceOffsets` exists
  // precisely to avoid this. Keep these tests so the two helpers' contracts
  // stay distinct.
  test('returns the earliest occurrence when the hint overshoots', () => {
    expect(findSegmentOffset('Yes. No. Maybe.', 'yes.', /* hint */ 50)).toBe(0);
  });

  test('falls back to from-start when the forward search misses', () => {
    // "echo" appears at index 0. Hint past the only occurrence should still
    // find it via the from-start fallback.
    expect(findSegmentOffset('echo and silence', 'echo', /* hint */ 10)).toBe(0);
  });
});

describe('resolveMonotonicSentenceOffsets', () => {
  test('returns monotonically non-decreasing offsets for sentences in order', () => {
    const spineText = 'The cat sat on the mat. The dog barked loudly. Then it was quiet.';
    const sentences = [
      'The cat sat on the mat.',
      'The dog barked loudly.',
      'Then it was quiet.',
    ];
    const offsets = resolveMonotonicSentenceOffsets(spineText, sentences);
    expect(offsets).toHaveLength(3);
    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i]).toBeGreaterThanOrEqual(offsets[i - 1]);
    }
  });

  test('does NOT jump backwards when a later sentence echoes earlier text', () => {
    // Regression: a sentence on the current page that happens to contain a
    // phrase also present earlier in the chapter (chapter title, refrain,
    // etc.) used to take the earlier occurrence's offset via
    // `findSegmentOffset`'s from-start fallback, which silently reordered
    // the sidebar's synth rows. The monotonic helper must never do that.
    const spineText = 'The Lighthouse. Several pages of narrative go here. The Lighthouse stood tall.';
    const sentences = [
      'Several pages of narrative go here.', // ~at offset 16
      'The Lighthouse stood tall.',           // recurs — must NOT jump back to offset 0
    ];
    const offsets = resolveMonotonicSentenceOffsets(spineText, sentences);
    expect(offsets[1]).toBeGreaterThan(offsets[0]);
  });

  test('holds the cursor for a sentence that cannot be found ahead', () => {
    const spineText = 'alpha beta gamma delta';
    const sentences = ['gamma', 'something not present', 'delta'];
    const offsets = resolveMonotonicSentenceOffsets(spineText, sentences);
    // gamma found, missing sentence holds cursor, delta found ahead of it.
    expect(offsets[0]).toBeGreaterThan(0);
    expect(offsets[1]).toBeGreaterThanOrEqual(offsets[0]); // monotonic
    expect(offsets[2]).toBeGreaterThan(offsets[1]); // delta is after gamma
  });

  test('handles empty inputs gracefully', () => {
    expect(resolveMonotonicSentenceOffsets('', ['anything'])).toEqual([0]);
    expect(resolveMonotonicSentenceOffsets('hello world', [])).toEqual([]);
    expect(resolveMonotonicSentenceOffsets('hello world', ['', '', ''])).toEqual([0, 0, 0]);
  });

  test('repeated phrase across the page is resolved at successive occurrences', () => {
    // Three "yes." sentences in a row should each pick the next occurrence,
    // not all pile onto the first one.
    const spineText = 'yes. yes. yes. end.';
    const sentences = ['yes.', 'yes.', 'yes.'];
    const offsets = resolveMonotonicSentenceOffsets(spineText, sentences);
    expect(new Set(offsets).size).toBe(3); // all distinct
    expect(offsets[0]).toBeLessThan(offsets[1]);
    expect(offsets[1]).toBeLessThan(offsets[2]);
  });

  test('normalizes whitespace and casing the same as segmentKey identity', () => {
    // The helper uses `normalizeSegmentIdentityText` internally so it agrees
    // with the segmentKey hash space. Different casing / whitespace must
    // still locate the sentence.
    const spineText = 'Hello   World.  More content here.';
    const sentences = ['hello world.', 'MORE content here.'];
    const offsets = resolveMonotonicSentenceOffsets(spineText, sentences);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBeGreaterThan(offsets[0]);
  });
});

describe('getSpineItemPlainText shape handling', () => {
  // Regression: epubjs's `Section.load()` resolves to the spine item's
  // `<html>` Element (NOT a Document). Reading `loaded.body` directly was
  // returning undefined for every spine item, so spineText came back ''
  // and every `findSegmentOffset` returned -1 → every persisted charOffset
  // ended up at 0. These tests pin both shapes so a future epubjs upgrade
  // (or a defensive rewrite) doesn't quietly break extraction again.
  test('extracts text when section.load resolves to an <html> Element', async () => {
    // Use the harness fixture which already returns a real <html> element
    // when DOM is available.
    if (typeof document === 'undefined') {
      // Skip in non-DOM environments.
      return;
    }
    const { book } = makeFakeBook([
      { index: 0, href: 'ch.xhtml', cfiBase: '/6/2', text: 'real text from html element' },
    ]);
    invalidateSpinePlainTextCache(book);
    const text = await getSpineItemPlainText(book, 'ch.xhtml');
    expect(text).toContain('real text');
  });

  test('extracts text when section.load resolves to a Document-shaped object', async () => {
    // Defensive: if a future epubjs version (or a custom shim) returns a
    // Document instead of an Element, the helper should still work.
    const fakeBook = {
      spine: {
        get: () => ({
          href: 'ch.xhtml',
          load: async () => ({
            body: { textContent: 'doc-shaped content' },
            documentElement: { textContent: 'doc-shaped content' },
          }),
          unload: () => {},
        }),
        spineItems: [],
      },
      load: () => Promise.resolve(undefined),
    } as unknown as Parameters<typeof getSpineItemPlainText>[0];
    const text = await getSpineItemPlainText(fakeBook, 'ch.xhtml');
    expect(text).toBe('doc-shaped content');
  });

  test('returns empty string when section.load resolves to null/undefined', async () => {
    const fakeBook = {
      spine: {
        get: () => ({
          href: 'ch.xhtml',
          load: async () => null,
          unload: () => {},
        }),
        spineItems: [],
      },
      load: () => Promise.resolve(undefined),
    } as unknown as Parameters<typeof getSpineItemPlainText>[0];
    const text = await getSpineItemPlainText(fakeBook, 'ch.xhtml');
    expect(text).toBe('');
  });
});

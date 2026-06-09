import { describe, expect, test } from 'vitest';
import type { Book } from 'epubjs';

import {
  buildEpubCanonicalWindow,
  buildEpubCanonicalWindowFromChunk,
  buildSpineCanonicalPlan,
  materializeWindowSegments,
  planSpineSegments,
  selectCanonicalWindow,
} from '../../src/lib/client/epub/epub-canonical-window';
import type { CanonicalTtsSegment } from '../../src/lib/shared/tts-segment-plan';

const SPINE_HREF = 'OEBPS/ch01.xhtml';
const SPINE_INDEX = 1;
const KEY_PREFIX = 'doc-1:epub:v1';
const MAX_BLOCK = 80;

// A chapter long enough that an ~80-char block grouping yields many segments,
// so a page break can be placed inside one of them.
const SENTENCES = [
  'The star was particularly bright when the station lights switched off for cycle night.',
  'After losing his staring match, the night janitor muttered and walked on alone.',
  'You might have called it aqua, or perhaps a faded green under the old glass.',
  'A titch too purple for hot pink, it was still impossible to ignore at noon.',
  'Needing no pole or wire to hold them aloft, the banners drifted above the plaza.',
  'He would have been confused to hear that this was considered a calm evening here.',
  'The lift doors parted onto a corridor that smelled faintly of ozone and rain.',
  'Somewhere below, a generator coughed twice and then settled into its low hum.',
];
const SPINE_TEXT = SENTENCES.join('\n');

function makeFakeBook(text: string): Book {
  const section = {
    index: SPINE_INDEX,
    href: SPINE_HREF,
    cfiBase: '/6/4',
    load: async () => ({
      querySelector: (sel: string) => (sel === 'body' ? { textContent: text } : null),
      textContent: text,
    }),
    unload: () => {},
  };
  const get = (target: unknown) => {
    if (typeof target === 'number') return target === SPINE_INDEX ? section : null;
    if (typeof target === 'string') {
      if (target === SPINE_HREF || target.includes(SPINE_HREF)) return section;
      if (target.includes(section.cfiBase)) return section;
    }
    return null;
  };
  return {
    isOpen: true,
    spine: { get, spineItems: [section] },
    load: () => Promise.resolve(undefined),
  } as unknown as Book;
}

const plan = (): CanonicalTtsSegment[] =>
  planSpineSegments({
    spineText: SPINE_TEXT,
    spineHref: SPINE_HREF,
    spineIndex: SPINE_INDEX,
    keyPrefix: KEY_PREFIX,
    maxBlockLength: MAX_BLOCK,
  });

describe('planSpineSegments', () => {
  test('produces sequential ordinals and stable keys', () => {
    const segments = plan();
    expect(segments.length).toBeGreaterThanOrEqual(6);
    segments.forEach((segment, i) => {
      expect(segment.ordinal).toBe(i);
      expect(segment.key.startsWith(`${KEY_PREFIX}:`)).toBe(true);
      // Within-chapter single source unit → never a "source boundary".
      expect(segment.spansSourceBoundary).toBe(false);
    });
  });
});

describe('selectCanonicalWindow — clean partition', () => {
  test('a block straddling a page break belongs only to the page where it starts', () => {
    const segments = plan();
    // Pick a block in the middle and place the page break inside it (the
    // viewport for page B begins partway through this straddling block).
    const boundary = segments[Math.floor(segments.length / 2)];
    const splitOffset = Math.floor((boundary.startAnchor.offset + boundary.endAnchor.offset) / 2);
    const chapterEnd = segments[segments.length - 1].endAnchor.offset + 1;

    const pageA = selectCanonicalWindow(segments, 0, splitOffset);
    const pageB = selectCanonicalWindow(segments, splitOffset, chapterEnd);
    expect(pageA).not.toBeNull();
    expect(pageB).not.toBeNull();

    // The straddler is the LAST segment of page A and is NOT on page B.
    expect(pageA!.endIndex).toBe(boundary.ordinal);
    expect(pageB!.startIndex).toBe(boundary.ordinal + 1);
  });

  test('page B starts exactly at boundary + 1 — no overlap, no gap (deterministic list)', () => {
    const segments = plan();
    const boundary = segments[Math.floor(segments.length / 2)];
    const splitOffset = Math.floor((boundary.startAnchor.offset + boundary.endAnchor.offset) / 2);
    const chapterEnd = segments[segments.length - 1].endAnchor.offset + 1;

    const pageA = selectCanonicalWindow(segments, 0, splitOffset)!;
    const pageB = selectCanonicalWindow(segments, splitOffset, chapterEnd)!;

    // The two pages partition the ordinals contiguously: …A.end | B.start…
    expect(pageB.startIndex).toBe(pageA.endIndex + 1);

    // The sidebar/manual-skip list for page B never contains a page-A segment.
    const windowB = segments.slice(pageB.startIndex, pageB.endIndex + 1);
    expect(windowB.every((s) => s.ordinal > boundary.ordinal)).toBe(true);
  });

  test('clean break (split between blocks) yields adjacent, non-overlapping ordinals', () => {
    const segments = plan();
    const before = segments[2];
    const after = segments[3];
    // Split exactly at the start of `after` (a clean sentence boundary).
    const splitOffset = after.startAnchor.offset;

    const pageA = selectCanonicalWindow(segments, 0, splitOffset)!;
    const pageB = selectCanonicalWindow(segments, splitOffset, segments[segments.length - 1].endAnchor.offset + 1)!;

    expect(pageA.endIndex).toBe(before.ordinal);
    expect(pageB.startIndex).toBe(after.ordinal);
    expect(pageB.startIndex).toBe(pageA.endIndex + 1);
  });

  test('is idempotent — identical offsets give identical keys/ordinals (resize safety)', () => {
    const segments = plan();
    const a = selectCanonicalWindow(segments, 120, 360)!;
    const b = selectCanonicalWindow(segments, 120, 360)!;
    expect(a).toEqual(b);
  });

  test('a block keeps its identity when the page break moves (resize / different sizes)', () => {
    const segments = plan();
    const s = segments[Math.floor(segments.length / 2)];
    const chapterEnd = segments[segments.length - 1].endAnchor.offset + 1;

    // Narrow viewport: the break lands right after `s`, so `s` is the LAST
    // segment on its page (page base starts at the chapter start).
    const narrow = selectCanonicalWindow(segments, 0, s.startAnchor.offset + 1)!;
    const narrowSegs = materializeWindowSegments(segments, narrow.startIndex, narrow.endIndex,
      { spineHref: SPINE_HREF, spineIndex: SPINE_INDEX, cfi: 'cfiA' },
      { sourceKey: 'pageA', baseOffset: 0, length: s.endAnchor.offset });
    const sInNarrow = narrowSegs[narrowSegs.length - 1];

    // Wider/shifted viewport: the break lands right before `s`, so the SAME
    // block is now the FIRST segment on a later page (different base offset).
    const wide = selectCanonicalWindow(segments, s.startAnchor.offset, chapterEnd)!;
    const wideSegs = materializeWindowSegments(segments, wide.startIndex, wide.endIndex,
      { spineHref: SPINE_HREF, spineIndex: SPINE_INDEX, cfi: 'cfiB' },
      { sourceKey: 'pageB', baseOffset: s.startAnchor.offset, length: chapterEnd - s.startAnchor.offset });
    const sInWide = wideSegs[0];

    // Identity is viewport-independent: same key, same ordinal, same audio
    // locator charOffset — so audio cache, sidebar, and persistence all agree
    // no matter how the chapter re-paginates.
    expect(sInWide.key).toBe(sInNarrow.key);
    expect(sInWide.ordinal).toBe(sInNarrow.ordinal);
    expect(sInWide.ownerLocator?.charOffset).toBe(sInNarrow.ownerLocator?.charOffset);
    expect(sInWide.ownerLocator?.charOffset).toBe(s.startAnchor.offset);

    // …but the highlight anchors are viewport-local, so they adapt to each page.
    expect(sInWide.startAnchor.sourceKey).toBe('pageB');
    expect(sInNarrow.startAnchor.sourceKey).toBe('pageA');
    expect(sInWide.startAnchor.offset).toBe(0); // first on its page → left edge
  });

  test('returns null when the start offset is past the end of the chapter', () => {
    const segments = plan();
    const past = segments[segments.length - 1].endAnchor.offset + 1000;
    expect(selectCanonicalWindow(segments, past, past + 10)).toBeNull();
  });
});

describe('materializeWindowSegments', () => {
  test('rewrites each ownerLocator with its own charOffset + cfi hint', () => {
    const segments = plan();
    const out = materializeWindowSegments(segments, 1, 3, {
      spineHref: SPINE_HREF,
      spineIndex: SPINE_INDEX,
      cfi: 'epubcfi(/6/4!/0)',
    });
    expect(out).toHaveLength(3);
    out.forEach((seg, i) => {
      const original = segments[i + 1];
      expect(seg.key).toBe(original.key);
      expect(seg.ordinal).toBe(original.ordinal);
      expect(seg.ownerLocator?.readerType).toBe('epub');
      expect(seg.ownerLocator?.spineHref).toBe(SPINE_HREF);
      expect(seg.ownerLocator?.charOffset).toBe(original.startAnchor.offset);
      expect(seg.ownerLocator?.cfi).toBe('epubcfi(/6/4!/0)');
    });
    // Does not mutate the source plan's locators.
    expect(segments[1].ownerLocator?.charOffset).toBe(0);
  });
});

describe('buildSpineCanonicalPlan (cached)', () => {
  test('returns the same plan reference for the same params and matches planSpineSegments', async () => {
    const book = makeFakeBook(SPINE_TEXT); // fresh Book → empty plan cache
    const first = await buildSpineCanonicalPlan(book, {
      spineHref: SPINE_HREF, spineIndex: SPINE_INDEX, keyPrefix: KEY_PREFIX, maxBlockLength: MAX_BLOCK,
    });
    const second = await buildSpineCanonicalPlan(book, {
      spineHref: SPINE_HREF, spineIndex: SPINE_INDEX, keyPrefix: KEY_PREFIX, maxBlockLength: MAX_BLOCK,
    });
    expect(second).toBe(first); // cache hit → identical reference
    expect(first.map((s) => s.key)).toEqual(plan().map((s) => s.key));
  });

  test('cache is language-aware: a different language is a cache miss', async () => {
    const book = makeFakeBook(SPINE_TEXT); // fresh Book → empty plan cache
    const base = {
      spineHref: SPINE_HREF, spineIndex: SPINE_INDEX, keyPrefix: KEY_PREFIX, maxBlockLength: MAX_BLOCK,
    };
    const en = await buildSpineCanonicalPlan(book, { ...base, language: 'en' });
    const ja = await buildSpineCanonicalPlan(book, { ...base, language: 'ja' });
    // Distinct language → distinct cache key → distinct reference (no stale
    // reuse across languages). Same language returns the cached reference.
    expect(ja).not.toBe(en);
    expect(await buildSpineCanonicalPlan(book, { ...base, language: 'en' })).toBe(en);
  });
});

describe('buildEpubCanonicalWindowFromChunk', () => {
  test('windows a chunk to canonical segments with playback-identical keys', async () => {
    const book = makeFakeBook(SPINE_TEXT);
    const segments = plan();
    const target = segments[3];
    const window = await buildEpubCanonicalWindowFromChunk(book, {
      spineHref: SPINE_HREF,
      spineIndex: SPINE_INDEX,
      chunkOffset: target.startAnchor.offset,
      text: target.text,
      cfi: 'epubcfi(/6/4!/8)',
      keyPrefix: KEY_PREFIX,
      maxBlockLength: MAX_BLOCK,
    });
    expect(window).not.toBeNull();
    expect(window!.segments[0].key).toBe(target.key);
    expect(window!.segments[0].ownerLocator?.charOffset).toBe(target.startAnchor.offset);
    expect(window!.windowStartOrdinal).toBe(target.ordinal);
  });
});

describe('buildEpubCanonicalWindow (CFI path)', () => {
  test('windows the visible viewport text into the chapter plan', async () => {
    const book = makeFakeBook(SPINE_TEXT);
    const segments = plan();
    // Viewport shows two consecutive sentences.
    const viewportText = `${SENTENCES[2]} ${SENTENCES[3]}`;
    const window = await buildEpubCanonicalWindow(book, {
      startCfi: 'epubcfi(/6/4!/0)',
      viewportText,
      keyPrefix: KEY_PREFIX,
      maxBlockLength: MAX_BLOCK,
    });
    expect(window).not.toBeNull();
    expect(window!.spineHref).toBe(SPINE_HREF);
    // The window's keys are all drawn from the single chapter plan.
    const planKeys = new Set(segments.map((s) => s.key));
    window!.segments.forEach((s) => expect(planKeys.has(s.key)).toBe(true));
  });

  test('rewrites anchors to viewport-local coordinates for highlighting', async () => {
    const book = makeFakeBook(SPINE_TEXT);
    const viewportText = `${SENTENCES[2]} ${SENTENCES[3]}`;
    const pageKey = 'page-sourcekey';
    const window = await buildEpubCanonicalWindow(book, {
      startCfi: 'epubcfi(/6/4!/0)',
      viewportText,
      keyPrefix: KEY_PREFIX,
      maxBlockLength: MAX_BLOCK,
      viewportAnchorSourceKey: pageKey,
    });
    expect(window).not.toBeNull();
    const viewportLen = viewportText.replace(/\s+/g, ' ').trim().length;
    window!.segments.forEach((seg) => {
      // Anchors point at the rendered map, not the spine.
      expect(seg.startAnchor.sourceKey).toBe(pageKey);
      expect(seg.endAnchor.sourceKey).toBe(pageKey);
      // ownerSourceKey is kept in lock-step so the word highlighter's
      // startAnchor.sourceKey === ownerSourceKey guard passes.
      expect(seg.ownerSourceKey).toBe(pageKey);
      // Offsets are viewport-local and clamped to the page.
      expect(seg.startAnchor.offset).toBeGreaterThanOrEqual(0);
      expect(seg.endAnchor.offset).toBeLessThanOrEqual(viewportLen);
      // ownerLocator (audio identity) stays spine-based.
      expect(seg.ownerLocator?.spineHref).toBe(SPINE_HREF);
    });
    // First visible segment starts at the page's left edge.
    expect(window!.segments[0].startAnchor.offset).toBe(0);
  });

  test('returns null when viewport text is not indexable in the spine (fallback signal)', async () => {
    const book = makeFakeBook(SPINE_TEXT);
    const window = await buildEpubCanonicalWindow(book, {
      startCfi: 'epubcfi(/6/4!/0)',
      viewportText: 'Text that does not appear anywhere in this chapter at all.',
      keyPrefix: KEY_PREFIX,
      maxBlockLength: MAX_BLOCK,
    });
    expect(window).toBeNull();
  });
});

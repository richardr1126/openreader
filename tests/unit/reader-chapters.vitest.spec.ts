import { describe, expect, it } from 'vitest';

import {
  chapterIndexForOrdinal,
  deriveChapters,
  type ChapterSegment,
} from '@/lib/client/reader/chapters';
import { epubTocOutline, findEpubTocTitle } from '@/lib/client/epub/toc-titles';

const epub = (spineHref: string, ordinal: number, text: string): ChapterSegment => ({
  ordinal,
  text,
  ownerLocator: { readerType: 'epub', spineHref, spineIndex: 0, charOffset: 0 },
});
const pdf = (page: number, ordinal: number): ChapterSegment => ({
  ordinal,
  text: `Sentence ${ordinal}.`,
  ownerLocator: { readerType: 'pdf', page, blockId: `b${ordinal}` },
});
const html = (location: string, ordinal: number): ChapterSegment => ({
  ordinal,
  text: `Sentence ${ordinal}.`,
  ownerLocator: { readerType: 'html', location },
});

describe('deriveChapters', () => {
  const book = [
    epub('OEBPS/cover.xhtml', 0, 'A very long dedication sentence that reads as prose rather than a heading at all.'),
    epub('OEBPS/ch1.xhtml', 1, 'Chapter I'),
    epub('OEBPS/ch1.xhtml', 2, 'Text.'),
    epub('OEBPS/ch2.xhtml', 3, 'Chapter II'),
    epub('OEBPS/ch3.xhtml', 4, 'More.'),
  ];

  it('names runs from the EPUB table of contents and keeps unnamed front matter', () => {
    const outline = epubTocOutline([
      { id: 'p', href: 'part.xhtml', label: 'Part One (image only)', subitems: [
        { id: '1', href: 'ch1.xhtml#start', label: 'The Cyclone' },
        { id: '1b', href: 'ch1.xhtml#later', label: 'Same file' },
        { id: '2', href: 'ch2.xhtml', label: 'The Council' },
      ] },
    ]);
    expect(deriveChapters(book, outline, 'Oz')).toEqual([
      { title: 'Chapter 1', startOrdinal: 0, endOrdinal: 0, depth: 0 },
      { title: 'The Cyclone', startOrdinal: 1, endOrdinal: 2, depth: 0 },
      { title: 'The Council', startOrdinal: 3, endOrdinal: 4, depth: 0 },
    ]);
  });

  it('infers EPUB chapters from resources when there is no outline', () => {
    expect(deriveChapters(book, [], 'Oz').map((chapter) => chapter.title))
      .toEqual(['Chapter 1', 'Chapter I', 'Chapter II', 'More.']);
  });

  it('uses PDF pages without an outline and the outline when present', () => {
    const doc = [pdf(1, 0), pdf(1, 1), pdf(2, 2), pdf(4, 3)];
    expect(deriveChapters(doc, [], 'Doc').map((chapter) => chapter.title))
      .toEqual(['Page 1', 'Page 2', 'Page 4']);
    expect(deriveChapters(doc, [
      { title: 'Intro', target: { readerType: 'pdf', page: 1 }, depth: 0 },
      { title: 'Missing page', target: { readerType: 'pdf', page: 3 }, depth: 0 },
      { title: 'Results', target: { readerType: 'pdf', page: 4 }, depth: 1 },
    ], 'Doc')).toEqual([
      { title: 'Intro', startOrdinal: 0, endOrdinal: 2, depth: 0 },
      { title: 'Results', startOrdinal: 3, endOrdinal: 3, depth: 1 },
    ]);
  });

  it('treats Markdown as one flow unless headings name blocks', () => {
    const doc = [html('b-0000', 0), html('b-0001', 1), html('b-0002', 2), html('b-0003', 3)];
    expect(deriveChapters(doc, [], 'notes.md')).toEqual([
      { title: 'notes.md', startOrdinal: 0, endOrdinal: 3, depth: 0 },
    ]);
    expect(deriveChapters(doc, [
      { title: 'Title', target: { readerType: 'html', location: 'b-0000' }, depth: 0 },
      { title: 'Section', target: { readerType: 'html', location: 'b-0002' }, depth: 1 },
    ], 'notes.md')).toEqual([
      { title: 'Title', startOrdinal: 0, endOrdinal: 1, depth: 0 },
      { title: 'Section', startOrdinal: 2, endOrdinal: 3, depth: 1 },
    ]);
  });

  it('locates the chapter of an ordinal', () => {
    const chapters = deriveChapters([pdf(1, 0), pdf(2, 1), pdf(2, 2)], [], 'Doc');
    expect(chapterIndexForOrdinal(chapters, 2)).toBe(1);
    expect(chapterIndexForOrdinal(chapters, null)).toBe(-1);
  });
});

describe('findEpubTocTitle', () => {
  it('matches spine hrefs by suffix after dropping fragments', () => {
    const toc = [{ id: 'a', href: 'Text/ch%201.xhtml#x', label: ' One ' }];
    expect(findEpubTocTitle(toc, 'OEBPS/Text/ch 1.xhtml')).toBe('One');
    expect(findEpubTocTitle(toc, 'OEBPS/Text/ch2.xhtml')).toBeNull();
  });
});

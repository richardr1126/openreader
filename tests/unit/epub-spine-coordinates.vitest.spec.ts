import { describe, expect, test } from 'vitest';
import type { Book } from 'epubjs';

import type { MappedChar } from '@/lib/client/highlight-char-map';
import {
  buildEpubRangeStartAnchor,
  resolveNormalizedRangeStartOffset,
  resolveSpineFromCfi,
} from '@/lib/client/epub/spine-coordinates';
import {
  clearEpubWindowIndex,
  findIndexedEpubWindowForLocator,
  registerEpubWindowIndexEntry,
} from '@/lib/client/epub/location-index';

function makeFakeBook(items: Array<{ index: number; href: string; cfiBase: string }>): Book {
  const sections = items.map((item) => ({ ...item }));
  return {
    isOpen: true,
    spine: {
      get: (target: unknown) => {
        if (typeof target === 'number') {
          return sections.find((section) => section.index === target) ?? null;
        }
        if (typeof target === 'string') {
          return sections.find((section) => (
            section.href === target || target.includes(section.cfiBase)
          )) ?? null;
        }
        return null;
      },
      spineItems: sections,
    },
  } as unknown as Book;
}

describe('EPUB CFI spine coordinates', () => {
  test('resolves the owning spine identity without treating the CFI as progress identity', () => {
    const book = makeFakeBook([
      { index: 2, href: 'OEBPS/ch02.xhtml', cfiBase: '/6/4' },
      { index: 3, href: 'OEBPS/ch03.xhtml', cfiBase: '/6/6' },
    ]);

    expect(resolveSpineFromCfi(book, 'epubcfi(/6/4!/4:0)')).toEqual({
      href: 'OEBPS/ch02.xhtml',
      index: 2,
    });
    expect(resolveSpineFromCfi(book, 'epubcfi(/99/2!/4:0)')).toBeNull();
  });

  test('maps a committed DOM range start directly into normalized character space', () => {
    const textNode = {} as Text;
    const normalizedCharacters: Array<MappedChar<{ node: Text; offset: number }>> =
      Array.from('alpha beta', (char, offset) => ({ char, pos: { node: textNode, offset } }));
    const range = {
      comparePoint: (node: Node, offset: number) => {
        if (node !== textNode) throw new Error('wrong document');
        if (offset < 6) return -1;
        if (offset === 6) return 0;
        return 1;
      },
    } as unknown as Range;

    expect(resolveNormalizedRangeStartOffset(range, normalizedCharacters)).toBe(6);
  });

  test('rejects a range whose positions belong to another document', () => {
    const normalizedCharacters = [{
      char: 'a',
      pos: { node: {} as Text, offset: 0 },
    }];
    const range = {
      comparePoint: () => { throw new Error('wrong document'); },
    } as unknown as Range;

    expect(resolveNormalizedRangeStartOffset(range, normalizedCharacters)).toBeNull();
  });

  test('builds the stable anchor from DOM order without searching rendered text', () => {
    const first = { textContent: 'alpha   ' } as unknown as Text;
    const second = { textContent: 'beta' } as unknown as Text;
    const nodes = [first, second];
    const pointOrder = new Map<Text, number>([[first, 0], [second, 8]]);
    let walkerIndex = 0;
    const doc = {
      defaultView: { NodeFilter: { SHOW_TEXT: 4 } },
      createTreeWalker: () => ({
        nextNode: () => nodes[walkerIndex++] ?? null,
      }),
    } as unknown as Document;
    const body = { ownerDocument: doc } as HTMLElement;
    Object.assign(doc, { body });
    Object.assign(first, { ownerDocument: doc });
    Object.assign(second, { ownerDocument: doc });

    const range = {
      startContainer: second,
      comparePoint: (node: Node, offset: number) => {
        const absolute = (pointOrder.get(node as Text) ?? -1) + offset;
        if (absolute < 8) return -1;
        if (absolute === 8) return 0;
        return 1;
      },
    } as unknown as Range;
    const book = makeFakeBook([{ index: 4, href: 'chapter.xhtml', cfiBase: '/6/8' }]);

    expect(buildEpubRangeStartAnchor(book, 'epubcfi(/6/8!/4:8)', range)).toEqual({
      spineHref: 'chapter.xhtml',
      spineIndex: 4,
      charOffset: 6,
    });
  });
});

describe('EPUB location index', () => {
  test('finds an indexed rendered window by stable spine charOffset', () => {
    const book = makeFakeBook([{ index: 0, href: 'ch.xhtml', cfiBase: '/6/2' }]);
    clearEpubWindowIndex(book);
    registerEpubWindowIndexEntry(book, {
      spineHref: 'ch.xhtml',
      spineIndex: 0,
      startCfi: 'epubcfi(/6/2!/4:0)',
      endCfi: 'epubcfi(/6/2!/4:20)',
      startCharOffset: 10,
      endCharOffset: 40,
      startOrdinal: 3,
      endOrdinal: 8,
    });

    expect(findIndexedEpubWindowForLocator(book, {
      readerType: 'epub',
      spineHref: 'ch.xhtml',
      spineIndex: 0,
      charOffset: 18,
    })?.startCfi).toBe('epubcfi(/6/2!/4:0)');

    expect(findIndexedEpubWindowForLocator(book, {
      readerType: 'epub',
      spineHref: 'ch.xhtml',
      spineIndex: 0,
      charOffset: 45,
    })).toBeNull();
  });
});

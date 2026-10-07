import { describe, expect, it } from 'vitest';

import {
  BOOK_SEARCH_RESULT_LIMIT,
  searchBook,
} from '@/lib/client/reader/book-search';

const segments = [
  { ordinal: 0, text: 'The Café   opened early.' },
  { ordinal: 1, text: 'Dorothy lived in the middle of the great Kansas prairies.' },
  { ordinal: 2, text: 'Aunt Em was afraid.' },
  { ordinal: 4, text: 'Uncle Henry never laughed.' },
];

describe('searchBook', () => {
  it('matches case- and diacritic-insensitively and reports the owning ordinal', () => {
    const [result, ...rest] = searchBook(segments, 'CAFE opened');
    expect(rest).toHaveLength(0);
    expect(result.ordinal).toBe(0);
    expect(result.snippet.slice(result.matchStart, result.matchEnd)).toBe('Café opened');
  });

  it('finds a phrase that spans a sentence boundary and assigns it to the first segment', () => {
    const results = searchBook(segments, 'prairies. aunt em');
    expect(results).toHaveLength(1);
    expect(results[0].ordinal).toBe(1);
    expect(results[0].snippet.slice(results[0].matchStart, results[0].matchEnd))
      .toBe('prairies. Aunt Em');
  });

  it('uses plan ordinals rather than array positions', () => {
    expect(searchBook(segments, 'uncle')[0].ordinal).toBe(4);
  });

  it('collapses whitespace in the query and ignores an empty query', () => {
    expect(searchBook(segments, '   ')).toEqual([]);
    expect(searchBook(segments, '  great\n kansas ')).toHaveLength(1);
  });

  it('trims snippets with ellipses around long context', () => {
    const long = `${'a '.repeat(80)}needle${' b'.repeat(80)}`;
    const [result] = searchBook([{ ordinal: 3, text: long }], 'needle');
    expect(result.snippet.startsWith('…')).toBe(true);
    expect(result.snippet.endsWith('…')).toBe(true);
    expect(result.snippet.slice(result.matchStart, result.matchEnd)).toBe('needle');
  });

  it('caps the number of results', () => {
    const many = Array.from({ length: 300 }, (_, ordinal) => ({ ordinal, text: 'echo echo' }));
    expect(searchBook(many, 'echo')).toHaveLength(BOOK_SEARCH_RESULT_LIMIT);
    expect(searchBook(many, 'echo', 3).map((result) => result.ordinal)).toEqual([0, 0, 1]);
  });
});

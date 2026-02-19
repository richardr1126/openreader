import { test, expect } from '@playwright/test';
import { 
  escapeFFMetadata,
  encodeChapterTitleTag,
  decodeChapterTitleTag,
  encodeChapterFileName,
  decodeChapterFileName
} from '../../src/lib/server/audiobooks/chapters';

test.describe('escapeFFMetadata', () => {
  test('escapes special characters correctly', () => {
    const input = 'Title with = ; # and backslash \\';
    // Expected: Equal -> \=, Semicolon -> \;, Hash -> \#, Backslash -> \\
    const expected = 'Title with \\= \\; \\# and backslash \\\\';
    expect(escapeFFMetadata(input)).toBe(expected);
  });

  test('normalizes newlines to spaces', () => {
    const input = 'Title with\nnewline and\rreturn';
    const expected = 'Title with newline and return';
    expect(escapeFFMetadata(input)).toBe(expected);
  });

  test('handles mixed special characters and newlines', () => {
    const input = 'Line1\nLine2=Value;Comment#';
    const expected = 'Line1 Line2\\=Value\\;Comment\\#';
    expect(escapeFFMetadata(input)).toBe(expected);
  });

  test('returns empty string as-is', () => {
    expect(escapeFFMetadata('')).toBe('');
  });

  test('returns safe string as-is', () => {
    const input = 'Safe Title 123';
    expect(escapeFFMetadata(input)).toBe(input);
  });
});

test.describe('Title Tags', () => {
  test('encodeChapterTitleTag formats correctly', () => {
    expect(encodeChapterTitleTag(0, 'Intro')).toBe('0001 - Intro');
    expect(encodeChapterTitleTag(9, 'Chapter Ten')).toBe('0010 - Chapter Ten');
  });

  test('encodeChapterTitleTag sanitizes inputs', () => {
    expect(encodeChapterTitleTag(0, 'Line\nBreak')).toBe('0001 - Line Break');
  });

  test('decodeChapterTitleTag parses correctly', () => {
    expect(decodeChapterTitleTag('0001 - Intro')).toEqual({ index: 0, title: 'Intro' });
    expect(decodeChapterTitleTag('10 - Chapter Ten')).toEqual({ index: 9, title: 'Chapter Ten' });
  });

  test('decodeChapterTitleTag handles flexible separators', () => {
    expect(decodeChapterTitleTag('1: Intro')).toEqual({ index: 0, title: 'Intro' });
    expect(decodeChapterTitleTag('1. Intro')).toEqual({ index: 0, title: 'Intro' });
  });

  test('decodeChapterTitleTag returns null for invalid input', () => {
    expect(decodeChapterTitleTag('Not a chapter')).toBeNull();
    expect(decodeChapterTitleTag('0 - Zero index invalid')).toBeNull(); 
  });
});

test.describe('Chapter File Names', () => {
  test('encodeChapterFileName formats correctly', () => {
    expect(encodeChapterFileName(0, 'Intro', 'mp3')).toBe('0001__Intro.mp3');
    expect(encodeChapterFileName(1, 'Part 2', 'm4b')).toBe('0002__Part%202.m4b');
  });

  test('encodeChapterFileName sanitizes dangerous characters', () => {
    // slash should be replaced by space -> then encoded
    expect(encodeChapterFileName(0, 'Ac/Dc', 'mp3')).toBe('0001__Ac%20Dc.mp3');
  });

  test('decodeChapterFileName parses correctly', () => {
    expect(decodeChapterFileName('0001__Intro.mp3')).toEqual({ index: 0, title: 'Intro', format: 'mp3' });
    expect(decodeChapterFileName('0002__Part%202.m4b')).toEqual({ index: 1, title: 'Part 2', format: 'm4b' });
  });

  test('decodeChapterFileName handles standard filenames without double-underscore', () => {
     // The regex requires double underscore: /^(\d{1,6})__(.+)\.(mp3|m4b)$/i
     expect(decodeChapterFileName('0001-chapter.mp3')).toBeNull();
  });
  
  test('round trip consistency', () => {
    const index = 5;
    const title = 'My Cool Chapter';
    const format = 'mp3';
    
    const encoded = encodeChapterFileName(index, title, format);
    const decoded = decodeChapterFileName(encoded);
    
    expect(decoded).toEqual({ index, title, format });
  });
});

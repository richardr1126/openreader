import { describe, expect, test } from 'vitest';
import {
  parseReaderInitialPosition,
  serializeReaderPosition,
} from '../../src/lib/client/reader-progress';

describe('reader progress contract', () => {
  test('parses PDF progress before the viewer is mounted', () => {
    expect(parseReaderInitialPosition('pdf', '12:7')).toEqual({
      readerType: 'pdf',
      location: 12,
      sentenceIndex: 7,
    });
  });

  test('parses HTML progress and preserves non-numeric locations', () => {
    expect(parseReaderInitialPosition('html', 'html:section%3Aintro:4')).toEqual({
      readerType: 'html',
      location: 'section:intro',
      sentenceIndex: 4,
    });
    expect(parseReaderInitialPosition('html', '3:2')).toEqual({
      readerType: 'html',
      location: 3,
      sentenceIndex: 2,
    });
  });

  test('uses a saved EPUB CFI directly and rejects directional commands', () => {
    expect(parseReaderInitialPosition('epub', 'epubcfi(/6/4!/4/2)')).toEqual({
      readerType: 'epub',
      location: 'epubcfi(/6/4!/4/2)',
    });
    expect(parseReaderInitialPosition('epub', 'next')).toBeNull();
  });

  test('rejects invalid or mismatched progress and serializes reader positions', () => {
    expect(parseReaderInitialPosition('pdf', 'epubcfi(/6/4)')).toBeNull();
    expect(parseReaderInitialPosition('html', 'html:%E0%A4%A:2')).toBeNull();
    expect(parseReaderInitialPosition('docx', '1:2')).toBeNull();
    expect(serializeReaderPosition('pdf', 8, 3)).toBe('8:3');
    expect(serializeReaderPosition('html', 'section:intro', 3)).toBe('html:section%3Aintro:3');
  });
});

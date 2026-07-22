import { describe, expect, test } from 'vitest';
import {
  parseReaderInitialPosition,
  serializeReaderPosition,
} from '../../src/lib/client/reader-progress';
import {
  parseEpubProgressLocator,
  serializeEpubProgressLocator,
} from '../../src/lib/shared/epub-progress';
import type { DocumentProgressRecord } from '../../src/types/user-state';

const record = (
  value: Pick<DocumentProgressRecord, 'readerType'> & Record<string, unknown>,
): DocumentProgressRecord => ({
  documentId: 'doc-1',
  progress: null,
  clientUpdatedAtMs: 1,
  updatedAtMs: 1,
  ...value,
} as DocumentProgressRecord);

describe('reader progress contract', () => {
  test('parses PDF progress before the viewer is mounted', () => {
    expect(parseReaderInitialPosition('pdf', record({ readerType: 'pdf', location: '12:7' }))).toEqual({
      readerType: 'pdf',
      location: 12,
      segmentOrdinal: 7,
    });
  });

  test('parses HTML progress and preserves non-numeric locations', () => {
    expect(parseReaderInitialPosition('html', record({ readerType: 'html', location: 'html:section%3Aintro:4' }))).toEqual({
      readerType: 'html',
      location: 'section:intro',
      segmentOrdinal: 4,
    });
    expect(parseReaderInitialPosition('html', record({ readerType: 'html', location: '3:2' }))).toBeNull();
  });

  test('uses only the versioned stable EPUB locator', () => {
    const locator = {
      schemaVersion: 1 as const,
      spineHref: ' chapter-2.xhtml ',
      spineIndex: 2.8,
      charOffset: 41.9,
    };
    expect(parseReaderInitialPosition('epub', record({ readerType: 'epub', locator }))).toEqual({
      readerType: 'epub',
      locator: {
        schemaVersion: 1,
        spineHref: 'chapter-2.xhtml',
        spineIndex: 2,
        charOffset: 41,
      },
    });
    expect(parseReaderInitialPosition('epub', record({
      readerType: 'epub',
      locator: { location: 'epubcfi(/6/4!/4/2)' },
    }))).toBeNull();
    const encoded = serializeEpubProgressLocator(locator);
    expect(parseEpubProgressLocator(encoded)).toEqual({
      schemaVersion: 1,
      spineHref: 'chapter-2.xhtml',
      spineIndex: 2,
      charOffset: 41,
    });
    expect(parseEpubProgressLocator('epubcfi(/6/4!/4/2)')).toBeNull();
  });

  test('rejects invalid or mismatched progress and serializes reader positions', () => {
    expect(parseReaderInitialPosition('pdf', record({ readerType: 'pdf', location: 'epubcfi(/6/4)' }))).toBeNull();
    expect(parseReaderInitialPosition('html', record({ readerType: 'html', location: 'html:%E0%A4%A:2' }))).toBeNull();
    expect(parseReaderInitialPosition('docx', record({ readerType: 'pdf', location: '1:2' }))).toBeNull();
    expect(serializeReaderPosition('pdf', 8, 3)).toBe('8:3');
    expect(serializeReaderPosition('html', 'section:intro', 3)).toBe('html:section%3Aintro:3');
  });
});

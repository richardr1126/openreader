import { expect, test } from '@playwright/test';
import { createPdfAudiobookSourceAdapter } from '../../src/lib/client/audiobooks/adapters/pdf';
import type { ParsedPdfDocument } from '../../src/types/parsed-pdf';
import type { DocumentSettings } from '../../src/types/document-settings';

test.describe('pdf audiobook adapter', () => {
  test('builds chapters from paragraph titles and filters skipped kinds', async () => {
    const parsed: ParsedPdfDocument = {
      schemaVersion: 1,
      documentId: 'doc-1',
      parserVersion: 'test',
      parsedAt: Date.now(),
      pages: [
        {
          pageNumber: 1,
          width: 100,
          height: 100,
          blocks: [
            {
              id: 'b1',
              kind: 'paragraph_title',
              text: 'Intro',
              fragments: [{ page: 1, bbox: [0, 80, 100, 90], text: 'Intro', readingOrder: 0 }],
            },
            {
              id: 'b2',
              kind: 'text',
              text: 'Welcome text.',
              fragments: [{ page: 1, bbox: [0, 60, 100, 79], text: 'Welcome text.', readingOrder: 1 }],
            },
            {
              id: 'b3',
              kind: 'header',
              text: 'Header line',
              fragments: [{ page: 1, bbox: [0, 95, 100, 100], text: 'Header line', readingOrder: 2 }],
            },
            {
              id: 'b4',
              kind: 'paragraph_title',
              text: 'Second',
              fragments: [{ page: 1, bbox: [0, 40, 100, 50], text: 'Second', readingOrder: 3 }],
            },
            {
              id: 'b5',
              kind: 'text',
              text: 'More body.',
              fragments: [{ page: 1, bbox: [0, 20, 100, 39], text: 'More body.', readingOrder: 4 }],
            },
          ],
        },
      ],
    };

    const settings: DocumentSettings = {
      schemaVersion: 1,
      pdf: {
        skipBlockKinds: ['header'],
      },
    };

    const adapter = createPdfAudiobookSourceAdapter({
      parsed,
      settings,
    });

    const chapters = await adapter.prepareChapters();
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('Intro');
    expect(chapters[0].text).toContain('Welcome text.');
    expect(chapters[0].text).not.toContain('Header line');
    expect(chapters[1].title).toBe('Second');
    expect(chapters[1].text).toContain('More body.');
  });

  test('keeps a single section chapter when only one heading is present', async () => {
    const parsed: ParsedPdfDocument = {
      schemaVersion: 1,
      documentId: 'doc-2',
      parserVersion: 'test',
      parsedAt: Date.now(),
      pages: [
        {
          pageNumber: 1,
          width: 100,
          height: 100,
          blocks: [
            {
              id: 'p1-title',
              kind: 'doc_title',
              text: 'Sample PDF',
              fragments: [{ page: 1, bbox: [0, 80, 100, 90], text: 'Sample PDF', readingOrder: 0 }],
            },
            {
              id: 'p1-text',
              kind: 'text',
              text: 'First page body.',
              fragments: [{ page: 1, bbox: [0, 50, 100, 79], text: 'First page body.', readingOrder: 1 }],
            },
          ],
        },
        {
          pageNumber: 2,
          width: 100,
          height: 100,
          blocks: [
            {
              id: 'p2-text',
              kind: 'text',
              text: 'Second page body.',
              fragments: [{ page: 2, bbox: [0, 50, 100, 79], text: 'Second page body.', readingOrder: 0 }],
            },
          ],
        },
      ],
    };

    const settings: DocumentSettings = {
      schemaVersion: 1,
      pdf: {
        skipBlockKinds: [],
      },
    };

    const adapter = createPdfAudiobookSourceAdapter({
      parsed,
      settings,
    });

    const chapters = await adapter.prepareChapters();
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('Sample PDF');
    expect(chapters[0].text).toContain('First page body.');
    expect(chapters[0].text).toContain('Second page body.');
  });
});

import { expect, test } from '@playwright/test';
import { createPdfAudiobookSourceAdapter } from '../../src/lib/client/audiobooks/adapters/pdf';
import type { ParsedPdfDocument } from '../../src/types/parsed-pdf';
import type { DocumentSettings } from '../../src/types/document-settings';

test.describe('pdf audiobook adapter', () => {
  test('builds chapters from section headers and filters skipped kinds', async () => {
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
              kind: 'section-header',
              text: 'Intro',
              fragments: [{ page: 1, bbox: [0, 80, 100, 90], text: 'Intro', readingOrder: 0 }],
            },
            {
              id: 'b2',
              kind: 'paragraph',
              text: 'Welcome text.',
              fragments: [{ page: 1, bbox: [0, 60, 100, 79], text: 'Welcome text.', readingOrder: 1 }],
            },
            {
              id: 'b3',
              kind: 'page-header',
              text: 'Header line',
              fragments: [{ page: 1, bbox: [0, 95, 100, 100], text: 'Header line', readingOrder: 2 }],
            },
            {
              id: 'b4',
              kind: 'section-header',
              text: 'Second',
              fragments: [{ page: 1, bbox: [0, 40, 100, 50], text: 'Second', readingOrder: 3 }],
            },
            {
              id: 'b5',
              kind: 'paragraph',
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
        skipBlockKinds: ['page-header'],
        chaptersFromSections: true,
      },
    };

    const adapter = createPdfAudiobookSourceAdapter({
      parsed,
      settings,
      margins: { header: 0.07, footer: 0.07, left: 0.07, right: 0.07 },
      smartSentenceSplitting: false,
    });

    const chapters = await adapter.prepareChapters();
    expect(chapters).toHaveLength(2);
    expect(chapters[0].title).toBe('Intro');
    expect(chapters[0].text).toContain('Welcome text.');
    expect(chapters[0].text).not.toContain('Header line');
    expect(chapters[1].title).toBe('Second');
    expect(chapters[1].text).toContain('More body.');
  });
});

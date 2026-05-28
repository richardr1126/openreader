import { expect, test } from '@playwright/test';
import { createHtmlAudiobookSourceAdapter } from '../../src/lib/client/audiobooks/adapters/html';
import { parseHtmlBlocks, type HtmlBlock } from '../../src/lib/client/html/blocks';

const blocksFromMd = (src: string): HtmlBlock[] => parseHtmlBlocks(src, false);
const blocksFromTxt = (src: string): HtmlBlock[] => parseHtmlBlocks(src, true);

test.describe('createHtmlAudiobookSourceAdapter (markdown chapter splitting)', () => {
  test('starts a new chapter at each h1/h2 heading by default', async () => {
    const blocks = blocksFromMd(
      [
        '# Alpha',
        '',
        'First chapter body.',
        '',
        '## Beta',
        '',
        'Second chapter body.',
        '',
        '### Gamma',
        '',
        'Subsection — should NOT begin a new chapter (h3 by default).',
        '',
        '## Delta',
        '',
        'Third chapter body.',
      ].join('\n'),
    );

    const adapter = createHtmlAudiobookSourceAdapter({
      blocks,
      isTxt: false,
    });
    const chapters = await adapter.prepareChapters();
    expect(chapters.map((c) => c.title)).toEqual(['Alpha', 'Beta', 'Delta']);
    // Subsection content lands inside its parent chapter (Beta).
    expect(chapters[1].text).toContain('Subsection');
  });

  test('treats blocks before the first heading as an "Introduction" chapter', async () => {
    const blocks = blocksFromMd(
      ['Top-of-doc paragraph.', '', '# First Heading', '', 'Body.'].join('\n'),
    );

    const adapter = createHtmlAudiobookSourceAdapter({
      blocks,
      isTxt: false,
    });
    const chapters = await adapter.prepareChapters();
    expect(chapters.map((c) => c.title)).toEqual(['Introduction', 'First Heading']);
    expect(chapters[0].text).toContain('Top-of-doc paragraph.');
    expect(chapters[1].text).toContain('Body.');
  });

  test('falls back to "Part N" chunks when markdown has no chapter-level headings', async () => {
    // No #/## headings → fallback path. Use a small fallback size for the
    // test so we don't have to generate 50+ blocks.
    const blocks = blocksFromMd(
      Array.from({ length: 7 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n'),
    );

    const adapter = createHtmlAudiobookSourceAdapter({
      blocks,
      isTxt: false,
      fallbackBlocksPerChapter: 3,
    });
    const chapters = await adapter.prepareChapters();
    expect(chapters.map((c) => c.title)).toEqual(['Part 1', 'Part 2', 'Part 3']);
    // 7 blocks / 3 per chapter → 3, 3, 1.
    expect(chapters[0].text).toContain('Paragraph 1.');
    expect(chapters[0].text).toContain('Paragraph 3.');
    expect(chapters[1].text).toContain('Paragraph 4.');
    expect(chapters[1].text).toContain('Paragraph 6.');
    expect(chapters[2].text).toContain('Paragraph 7.');
    expect(chapters[2].text).not.toContain('Paragraph 6.');
  });

  test('honors a custom chapterHeadingLevel (e.g. h1 only)', async () => {
    const blocks = blocksFromMd(
      ['# Alpha', '', 'A body.', '', '## Beta', '', 'B body.', '', '# Gamma', '', 'G body.'].join(
        '\n',
      ),
    );

    const adapter = createHtmlAudiobookSourceAdapter({
      blocks,
      isTxt: false,
      chapterHeadingLevel: 1,
    });
    const chapters = await adapter.prepareChapters();
    // h2 (Beta) is absorbed into the Alpha chapter when only h1 starts chapters.
    expect(chapters.map((c) => c.title)).toEqual(['Alpha', 'Gamma']);
    expect(chapters[0].text).toContain('Beta');
    expect(chapters[0].text).toContain('B body.');
  });
});

test.describe('createHtmlAudiobookSourceAdapter (txt chapter splitting)', () => {
  test('chunks TXT documents into "Part N" of 50 blocks by default', async () => {
    const blocks = blocksFromTxt(
      Array.from({ length: 120 }, (_, i) => `Block ${i + 1}.`).join('\n\n'),
    );
    expect(blocks.length).toBe(120);

    const adapter = createHtmlAudiobookSourceAdapter({
      blocks,
      isTxt: true,
    });
    const chapters = await adapter.prepareChapters();
    expect(chapters.map((c) => c.title)).toEqual(['Part 1', 'Part 2', 'Part 3']);
    // First chapter contains blocks 1..50, last contains 101..120.
    expect(chapters[0].text).toContain('Block 1.');
    expect(chapters[0].text).toContain('Block 50.');
    expect(chapters[0].text).not.toContain('Block 51.');
    expect(chapters[2].text).toContain('Block 101.');
    expect(chapters[2].text).toContain('Block 120.');
  });

  test('ignores headings in TXT mode (everything goes through the Part-N path)', async () => {
    // A line that LOOKS like a markdown heading in a .txt file is still
    // just text — we shouldn't carve a chapter at it.
    const blocks = blocksFromTxt('# Looks like a heading\n\nBut TXT mode treats it as a paragraph.');
    const adapter = createHtmlAudiobookSourceAdapter({
      blocks,
      isTxt: true,
    });
    const chapters = await adapter.prepareChapters();
    expect(chapters.length).toBe(1);
    expect(chapters[0].title).toBe('Part 1');
  });
});

test.describe('createHtmlAudiobookSourceAdapter — prepareChapter', () => {
  test('returns the same chapter by index that prepareChapters lists', async () => {
    const blocks = blocksFromMd(['# A', '', 'one', '', '## B', '', 'two'].join('\n'));
    const adapter = createHtmlAudiobookSourceAdapter({
      blocks,
      isTxt: false,
    });
    const list = await adapter.prepareChapters();
    const second = await adapter.prepareChapter(1);
    expect(second.title).toBe(list[1].title);
    expect(second.text).toBe(list[1].text);
  });

  test('throws on out-of-range chapter index', async () => {
    const blocks = blocksFromMd('# Only\n\nbody.');
    const adapter = createHtmlAudiobookSourceAdapter({
      blocks,
      isTxt: false,
    });
    await expect(adapter.prepareChapter(42)).rejects.toThrow(/invalid chapter index/i);
  });
});

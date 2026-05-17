import { expect, test } from '@playwright/test';
import {
  mdToPlainText,
  parseHtmlBlocks,
  splitMarkdownBlocks,
  splitTxtBlocks,
} from '../../src/lib/client/html/blocks';

test.describe('parseHtmlBlocks (markdown)', () => {
  test('splits headings, paragraphs, and lists into separate blocks', () => {
    const src = [
      '# Title',
      '',
      'First paragraph of text.',
      '',
      '- one',
      '- two',
      '',
      '## Subhead',
      '',
      'Second paragraph.',
    ].join('\n');

    const blocks = parseHtmlBlocks(src, false);
    expect(blocks.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'heading',
      'paragraph',
    ]);
    expect(blocks[0].headingLevel).toBe(1);
    expect(blocks[0].headingText).toBe('Title');
    expect(blocks[3].headingLevel).toBe(2);
    expect(blocks[3].headingText).toBe('Subhead');
  });

  test('assigns stable padded anchor ids in document order', () => {
    const src = '# A\n\nB\n\nC';
    const blocks = parseHtmlBlocks(src, false);
    expect(blocks.map((b) => b.anchorId)).toEqual(['b-0000', 'b-0001', 'b-0002']);
  });

  test('treats fenced code blocks as a single block and preserves content verbatim', () => {
    const src = ['Intro.', '', '```ts', 'const x = 1;', 'const y = 2;', '```', '', 'Outro.'].join(
      '\n',
    );
    const blocks = parseHtmlBlocks(src, false);
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'code', 'paragraph']);
    // Code plainText keeps the inner lines as-is (fence lines stripped).
    expect(blocks[1].plainText).toContain('const x = 1;');
    expect(blocks[1].plainText).toContain('const y = 2;');
    // Fence markers themselves shouldn't survive into plainText.
    expect(blocks[1].plainText).not.toContain('```');
  });
});

test.describe('parseHtmlBlocks (txt)', () => {
  test('splits on blank-line boundaries and preserves intra-block whitespace', () => {
    const src = 'First block\nmore.\n\nSecond block.\n\n\nThird block.';
    const blocks = parseHtmlBlocks(src, true);
    expect(blocks.length).toBe(3);
    expect(blocks[0].kind).toBe('paragraph');
    expect(blocks[0].plainText).toBe('First block more.');
    expect(blocks[1].plainText).toBe('Second block.');
    expect(blocks[2].plainText).toBe('Third block.');
  });

  test('skips empty blocks produced by trailing newlines', () => {
    const blocks = splitTxtBlocks('A\n\n\n\n');
    expect(blocks.length).toBe(1);
    expect(blocks[0].plainText).toBe('A');
  });
});

test.describe('mdToPlainText badge/image stripping', () => {
  // The bug: badge alt text was being kept in plainText. Since the rendered
  // DOM is just an <img> with no text node, the sentence-highlight pattern
  // matcher couldn't find those words and the WHOLE first-segment match
  // silently dropped below threshold. These tests are the regression guard.

  test('drops image-link wrappers entirely ([![alt](badge)](link) → "")', () => {
    expect(
      mdToPlainText(
        '[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)',
        'paragraph',
      ),
    ).toBe('');
  });

  test('drops standalone images entirely (![alt](url) → "")', () => {
    expect(mdToPlainText('![cover](cover.jpg)', 'paragraph')).toBe('');
  });

  test('drops reference-style images (![alt][ref] → "")', () => {
    expect(mdToPlainText('![cover][cover-ref]', 'paragraph')).toBe('');
  });

  test('drops inline <img> HTML tags', () => {
    expect(mdToPlainText('<img src="x.png" alt="x"/>', 'paragraph')).toBe('');
  });

  test('keeps surrounding text when a paragraph mixes badges and prose', () => {
    const out = mdToPlainText(
      '[![Build](build.svg)](ci) Welcome to the project. ![logo](logo.png) Read on.',
      'paragraph',
    );
    // Badge / image syntax gone; visible prose preserved (with collapsed
    // whitespace from the trim/normalize pass).
    expect(out).toBe('Welcome to the project. Read on.');
  });

  test('still extracts visible label text from regular links', () => {
    // Links DO render visible text in the DOM, so the label must survive.
    expect(mdToPlainText('See the [docs](https://example.com) for more.', 'paragraph')).toBe(
      'See the docs for more.',
    );
  });

  test('strips inline markdown emphasis but keeps the words', () => {
    expect(mdToPlainText('A **bold** and *italic* and `code` word.', 'paragraph')).toBe(
      'A bold and italic and code word.',
    );
  });
});

test.describe('buildFullDocumentText-style integration (badge-only blocks)', () => {
  // If a paragraph is composed only of badges, its plainText is empty after
  // stripping. The reader filters empty plainText out of the TTS source
  // (`useHtmlDocument#buildFullDocumentText`), so badge blocks don't generate
  // a phantom segment that would later fail to highlight.
  test('badge-only paragraphs collapse to empty plainText', () => {
    const src = [
      '# Project',
      '',
      '[![License](license.svg)](LICENSE) [![Build](build.svg)](ci)',
      '',
      'Real description here.',
    ].join('\n');

    const blocks = splitMarkdownBlocks(src);
    expect(blocks.length).toBe(3);
    const [heading, badgesBlock, description] = blocks;
    expect(heading.plainText).toBe('Project');
    expect(badgesBlock.plainText.trim()).toBe('');
    expect(description.plainText).toBe('Real description here.');
  });
});

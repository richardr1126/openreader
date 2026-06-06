import { describe, expect, test } from 'vitest';
import { 
  preprocessSentenceForAudio, 
  splitTextToTtsBlocks, 
  splitTextToTtsBlocksEPUB,
  normalizeTextForTts,
  MAX_BLOCK_LENGTH
} from '../../src/lib/shared/nlp';

const PDF_MAX_BLOCK_LENGTH = MAX_BLOCK_LENGTH * 2; // splitTextToTtsBlocks can overflow to reach punctuation

const expectNormalizedBlocks = (blocks: string[], maxLen = Number.POSITIVE_INFINITY) => {
  for (const block of blocks) {
    expect(block.trim().length).toBeGreaterThan(0);
    expect(block.length).toBeLessThanOrEqual(maxLen);
    expect(block).not.toMatch(/\n/);
    expect(block).not.toMatch(/\s{2,}/);
  }
};

describe('preprocessSentenceForAudio', () => {
  test('normalizes common extraction artifacts', () => {
    const cases: Array<{ input: string; expected: string }> = [
      {
        input: 'Check out https://example.com/page for more info',
        expected: 'Check out - (link to example.com) - for more info',
      },
      {
        input: 'This is a hyp- henated word',
        expected: 'This is a hyphenated word',
      },
      {
        input: 'This is *bold* text',
        expected: 'This is bold text',
      },
      {
        input: 'Multiple    spaces',
        expected: 'Multiple spaces',
      },
    ];

    for (const { input, expected } of cases) {
      expect(preprocessSentenceForAudio(input)).toBe(expected);
    }
  });
});

describe('splitTextToTtsBlocks (PDF-oriented)', () => {
  test('uses locale-aware sentence boundaries for Japanese and Chinese', () => {
    expect(splitTextToTtsBlocks(
      'これは最初の文です。これは二番目の文です。',
      { language: 'ja', maxBlockLength: 50 },
    )).toEqual(['これは最初の文です。これは二番目の文です。']);

    const chinese = splitTextToTtsBlocks(
      Array(12).fill('这是一个用于测试分句的中文句子。').join(''),
      { language: 'zh', maxBlockLength: 50 },
    );
    expect(chinese.length).toBeGreaterThan(1);
    expect(chinese.join('')).toContain('用于测试分句');
  });

  test('returns [] for empty input', () => {
    expect(splitTextToTtsBlocks('')).toEqual([]);
    expect(splitTextToTtsBlocks('   ')).toEqual([]);
    expect(splitTextToTtsBlocks('\n\n')).toEqual([]);
  });

  test('does not treat single newlines as paragraph boundaries', () => {
    const input =
      'The first line ends with a comma,\n' +
      'but the sentence continues on the next line and ends here.\n' +
      'And this is the second sentence.';
    const result = splitTextToTtsBlocks(input);

    expect(result).toHaveLength(1);
    expectNormalizedBlocks(result, PDF_MAX_BLOCK_LENGTH);
    expect(result[0]).toBe(
      'The first line ends with a comma, but the sentence continues on the next line and ends here. And this is the second sentence.'
    );
  });

  test('treats blank lines (double newlines) as paragraph boundaries', () => {
    const input = 'First paragraph.\n\nSecond paragraph.';
    const result = splitTextToTtsBlocks(input);

    expect(result.length).toBeGreaterThanOrEqual(2);
    expectNormalizedBlocks(result, PDF_MAX_BLOCK_LENGTH);
  });

  test('repairs missing whitespace between sentences (common PDF artifact)', () => {
    const input = 'This ends.Here starts.';
    const normalized = normalizeTextForTts(input);
    expect(normalized).toContain('ends. Here');
  });

  test('does not break decimals when repairing sentence boundaries', () => {
    const input = 'Pi is 3.14.Next sentence.';
    const normalized = normalizeTextForTts(input);
    expect(normalized).toContain('3.14');
  });

  test('enforces max block length on long content', () => {
    const sentence = `${'A'.repeat(100)}.`; // 101 chars
    const input = Array(8).fill(sentence).join(' '); // guaranteed to exceed MAX_BLOCK_LENGTH
    const result = splitTextToTtsBlocks(input);

    expect(result.length).toBeGreaterThan(1);
    expectNormalizedBlocks(result, MAX_BLOCK_LENGTH);
  });

  test('splits oversized content with no punctuation', () => {
    const input = Array(1200).fill('word').join(' ');
    const result = splitTextToTtsBlocks(input);

    expect(result.length).toBeGreaterThan(1);
    expectNormalizedBlocks(result, MAX_BLOCK_LENGTH);
  });

  test('splits extremely long unbroken tokens', () => {
    const input = 'A'.repeat(1200);
    const result = splitTextToTtsBlocks(input);

    expect(result.length).toBeGreaterThan(1);
    expectNormalizedBlocks(result, MAX_BLOCK_LENGTH);
  });

  test('supports configurable max block length', () => {
    const input = Array(600).fill('word').join(' ');
    const result = splitTextToTtsBlocks(input, { maxBlockLength: 220 });

    expect(result.length).toBeGreaterThan(1);
    expectNormalizedBlocks(result, 220 * 2);
  });

  test('prefers sentence punctuation when chunking long PDF-like text', () => {
    const sentences = Array.from(
      { length: 80 },
      (_, i) => `Sentence ${i} has filler words to vary length slightly number ${i}.`
    );
    const input = sentences.join(''); // no whitespace after '.' between sentences
    const result = splitTextToTtsBlocks(input);

    expect(result.length).toBeGreaterThan(1);
    expectNormalizedBlocks(result, PDF_MAX_BLOCK_LENGTH);

    // When sentence punctuation exists, blocks should usually end at punctuation/closers.
    // This guards against regressions where we cut mid-word/mid-sentence too often.
    for (const block of result) {
      expect(block).toMatch(/[.!?]["'”’)\]]*$/);
    }
  });

  test('allows a long sentence to extend to its ending punctuation', () => {
    // Create a single sentence that exceeds MAX_BLOCK_LENGTH, but ends with a period
    // within the forward-search overflow window.
    const input = `${'word '.repeat(110)}end. Next.`;
    const result = splitTextToTtsBlocks(input);

    expect(result.length).toBeGreaterThan(1);
    // This case is specifically asserting we may exceed MAX_BLOCK_LENGTH to reach punctuation,
    // but should still remain bounded by the overflow policy.
    expectNormalizedBlocks(result, PDF_MAX_BLOCK_LENGTH);
    expect(result[0]).toMatch(/end\.$/);
  });

  test('merges multi-sentence quoted dialogue', () => {
    const input = 'He said, "First. Second." Then left.';
    const result = splitTextToTtsBlocks(input);

    expect(result).toHaveLength(1);
    expectNormalizedBlocks(result, PDF_MAX_BLOCK_LENGTH);
    expect(result[0]).toContain('"First. Second."');
  });
});

describe('splitTextToTtsBlocksEPUB (highlight-friendly)', () => {
  test('returns [] for empty input', () => {
    expect(splitTextToTtsBlocksEPUB('')).toEqual([]);
    expect(splitTextToTtsBlocksEPUB('   ')).toEqual([]);
    expect(splitTextToTtsBlocksEPUB('\n\n')).toEqual([]);
  });

  test('treats single newlines as paragraph boundaries', () => {
    const input = 'One.\nTwo.';
    const result = splitTextToTtsBlocksEPUB(input);
    expect(result).toHaveLength(2);
    expectNormalizedBlocks(result, MAX_BLOCK_LENGTH);
    expect(result[0]).toBe('One.');
    expect(result[1]).toBe('Two.');
  });

  test('splits oversized sentences to keep blocks bounded', () => {
    const input = Array(1200).fill('word').join(' '); // no punctuation; guaranteed to exceed MAX_BLOCK_LENGTH
    const result = splitTextToTtsBlocksEPUB(input);

    expect(result.length).toBeGreaterThan(1);
    expectNormalizedBlocks(result, MAX_BLOCK_LENGTH);
  });

  test('supports configurable max block length for EPUB mode', () => {
    const input = Array(600).fill('word').join(' ');
    const result = splitTextToTtsBlocksEPUB(input, { maxBlockLength: 180 });

    expect(result.length).toBeGreaterThan(1);
    expectNormalizedBlocks(result, 180);
  });
});

describe('normalizeTextForTts', () => {
  test('returns a single normalized string without newlines', () => {
    const input = 'Hello.\nWorld.\n\nNext paragraph.';
    const normalized = normalizeTextForTts(input);
    expect(normalized).not.toMatch(/\n/);
    expect(normalized).not.toMatch(/\s{2,}/);
    expect(normalized.length).toBeGreaterThan(0);
  });

  test('does not insert spaces between normalized Japanese blocks', () => {
    expect(normalizeTextForTts('最初の文です。次の文です。', {
      language: 'ja',
      maxBlockLength: 7,
    })).toBe('最初の文です。次の文です。');
  });
});

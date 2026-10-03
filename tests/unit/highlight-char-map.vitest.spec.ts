import { describe, expect, test } from 'vitest';

import { normalizeMappedChars, type MappedChar } from '@/lib/client/highlight-char-map';

describe('position-preserving highlight normalization', () => {
  test('normalizes a chapter longer than the engine call-argument limit', () => {
    const text = 'Call me Ishmael. '.repeat(200_000);
    const tokens: Array<MappedChar<number>> = Array.from(text, (char, pos) => ({ char, pos }));

    const normalized = normalizeMappedChars(tokens);

    expect(normalized).toHaveLength(text.trimEnd().length);
    expect(normalized[5]).toEqual({ char: 'm', pos: 5 });
    expect(normalized.at(-1)).toEqual({ char: '.', pos: text.length - 2 });
  });
});

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  inferKokoroLanguageFromVoice,
  normalizeUnicodeToken,
  resolveTtsLanguage,
  segmentSentences,
  segmentWords,
  toBaseLanguageCode,
} from '../../src/lib/shared/language';

describe('multilingual language utilities', () => {
  test('keeps the multilingual document fixture readable as UTF-8', () => {
    const fixture = readFileSync(resolve(process.cwd(), 'tests/files/multilingual-sample.txt'), 'utf8');
    expect(fixture).toContain('これは二番目の文です。');
    expect(fixture).toContain('这是第二句话。');
    expect(fixture).toContain('هذه هي الجملة الثانية.');
  });

  test('infers Kokoro language from a single-language voice selection', () => {
    expect(inferKokoroLanguageFromVoice('jf_alpha')).toBe('ja');
    expect(inferKokoroLanguageFromVoice('zf_xiaobei(0.5)+zm_yunxi(0.5)')).toBe('zh-CN');
    expect(inferKokoroLanguageFromVoice('ff_siwis+jf_alpha')).toBeNull();
  });

  test('prefers an explicit language and resolves regional tags for Whisper', () => {
    expect(resolveTtsLanguage({ configuredLanguage: 'pt-BR', voice: 'jf_alpha' })).toBe('pt-BR');
    expect(resolveTtsLanguage({ configuredLanguage: 'auto', voice: 'jf_alpha' })).toBe('ja');
    expect(toBaseLanguageCode('zh-CN')).toBe('zh');
  });

  test('normalizes Unicode tokens without dropping non-Latin scripts', () => {
    expect(normalizeUnicodeToken('École!')).toBe('école');
    expect(normalizeUnicodeToken('日本語。')).toBe('日本語');
    expect(normalizeUnicodeToken('العربية؟')).toBe('العربية');
    expect(normalizeUnicodeToken('हिन्दी।')).toBe('हिन्दी');
  });

  test('segments CJK sentences and no-space language words', () => {
    expect(segmentSentences('これは最初の文です。これは二番目の文です。', 'ja')).toEqual([
      'これは最初の文です。',
      'これは二番目の文です。',
    ]);

    const chineseWords = segmentWords('这是第一句话。', 'zh').map((token) => token.text);
    expect(chineseWords.length).toBeGreaterThan(1);
    expect(chineseWords.join('')).toBe('这是第一句话');
  });

  test('preserves source offsets for Thai word segmentation', () => {
    const text = 'นี่คือประโยคแรก';
    const words = segmentWords(text, 'th');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(text.slice(word.start, word.end)).toBe(word.text);
    }
  });
});

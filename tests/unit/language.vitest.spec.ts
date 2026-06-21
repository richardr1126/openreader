import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  getTtsLanguageCompatibilityWarnings,
  inferKokoroLanguageFromVoice,
  keepKokoroVoicesInOneLanguage,
  normalizeOptionalLanguageTag,
  normalizeUnicodeToken,
  resolveReplicateKokoroLanguageCode,
  resolveTtsLanguage,
  segmentSentences,
  segmentWords,
  toBaseLanguageCode,
} from '@openreader/tts/language';

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

  test('keeps Kokoro multi-voice selections within the newly selected language', () => {
    expect(keepKokoroVoicesInOneLanguage(
      ['af_sarah', 'bf_emma', 'jf_alpha'],
      'jf_alpha',
    )).toEqual(['jf_alpha']);

    expect(keepKokoroVoicesInOneLanguage(
      ['zf_xiaobei', 'zm_yunxi', 'af_sarah'],
      'zm_yunxi',
    )).toEqual(['zf_xiaobei', 'zm_yunxi']);

    expect(keepKokoroVoicesInOneLanguage(
      ['af_sarah', 'bf_emma'],
      'bf_emma',
    )).toEqual(['af_sarah', 'bf_emma']);
  });

  test('normalizes valid EPUB metadata language tags and rejects invalid metadata', () => {
    expect(normalizeOptionalLanguageTag(' ja-jp ')).toBe('ja-JP');
    expect(normalizeOptionalLanguageTag('fr, en')).toBe('fr');
    expect(normalizeOptionalLanguageTag('not_a_language')).toBeNull();
    expect(normalizeOptionalLanguageTag(undefined)).toBeNull();
  });

  test('warns only for provable Kokoro language compatibility problems', () => {
    expect(getTtsLanguageCompatibilityWarnings({
      model: 'kokoro',
      voice: 'jf_alpha',
      documentLanguage: 'ja',
    })).toEqual([]);

    expect(getTtsLanguageCompatibilityWarnings({
      model: 'kokoro',
      voice: 'af_sarah',
      documentLanguage: 'ja',
    })).toEqual([
      'Selected Kokoro voice is American English, but the document is Japanese.',
    ]);

    expect(getTtsLanguageCompatibilityWarnings({
      model: 'kokoro',
      voice: 'ff_siwis+jf_alpha',
      documentLanguage: 'fr',
    })).toEqual([]);

    expect(getTtsLanguageCompatibilityWarnings({
      model: 'kokoro',
      voice: 'af_sarah',
      documentLanguage: 'ar',
    })).toEqual([
      "Kokoro's built-in voice catalog does not include Arabic.",
      'Selected Kokoro voice is American English, but the document is Arabic.',
    ]);

    expect(getTtsLanguageCompatibilityWarnings({
      model: 'custom-unknown-model',
      voice: 'af_sarah',
      documentLanguage: 'ja',
    })).toEqual([]);
  });

  test('prefers an explicit language and resolves regional tags for Whisper', () => {
    expect(resolveTtsLanguage({ configuredLanguage: 'pt-BR', voice: 'jf_alpha' })).toBe('pt-BR');
    expect(resolveTtsLanguage({ configuredLanguage: 'auto', voice: 'jf_alpha' })).toBe('ja');
    expect(toBaseLanguageCode('zh-CN')).toBe('zh');
  });

  test('maps Kokoro voices and normalized language tags to Replicate language codes', () => {
    expect(resolveReplicateKokoroLanguageCode({ language: 'en', voice: 'af_sarah' })).toBe('a');
    expect(resolveReplicateKokoroLanguageCode({ language: 'en', voice: 'bf_emma' })).toBe('b');
    expect(resolveReplicateKokoroLanguageCode({ language: 'ja-JP', voice: 'jf_alpha' })).toBe('j');
    expect(resolveReplicateKokoroLanguageCode({ language: 'zh-TW', voice: 'zf_xiaobei' })).toBe('z');
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

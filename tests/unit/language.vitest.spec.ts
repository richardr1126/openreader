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
      'Selected Kokoro voice is American English, but the document is Japanese. Select a Japanese voice.',
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
      "Kokoro's built-in voice catalog does not include Arabic. Choose another model.",
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

  test('warns against detected French even when Auto playback follows an English Kokoro voice', () => {
    const input = { configuredLanguage: 'auto', documentLanguage: 'fr', voice: 'af_heart' };
    expect(resolveTtsLanguage(input)).toBe('en-US');
    expect(getTtsLanguageCompatibilityWarnings({ ...input, model: 'kokoro' })).toEqual([
      'Selected Kokoro voice is American English, but the document is French. Select a French voice.',
    ]);
    expect(getTtsLanguageCompatibilityWarnings({ ...input, model: 'kokoro', voice: 'ff_siwis' })).toEqual([]);
  });

  test('uses the explicit warning language ahead of conflicting detected metadata', () => {
    expect(getTtsLanguageCompatibilityWarnings({
      model: 'kokoro', configuredLanguage: 'en', documentLanguage: 'fr', voice: 'af_heart',
    })).toEqual([]);
    expect(getTtsLanguageCompatibilityWarnings({
      model: 'kokoro', configuredLanguage: 'fr', documentLanguage: 'tr', voice: 'af_heart',
    })).toEqual([
      'Selected Kokoro voice is American English, but the document is French. Select a French voice.',
    ]);
  });

  test('directs unsupported Turkish documents to another model', () => {
    expect(getTtsLanguageCompatibilityWarnings({
      model: 'kokoro', configuredLanguage: 'auto', documentLanguage: 'tr', voice: 'af_heart',
    })).toEqual(["Kokoro's built-in voice catalog does not include Turkish. Choose another model."]);
  });

  test('uses the narrower local Kokoro voice catalogue for warnings', () => {
    expect(getTtsLanguageCompatibilityWarnings({
      model: 'kokoro-82m', providerType: 'kokoro-local', configuredLanguage: 'auto', documentLanguage: 'fr', voice: 'af_heart',
    })).toEqual(["Local Kokoro's voice catalog does not include French. Choose another model."]);
    expect(getTtsLanguageCompatibilityWarnings({
      model: 'kokoro-82m', providerType: 'kokoro-local', configuredLanguage: 'en', documentLanguage: 'fr', voice: 'af_heart',
    })).toEqual([]);
  });

  test.each([null, undefined, '', 'auto', 'not_a_language', 'und'])('does not assume English for unknown document language %s', (documentLanguage) => {
    expect(getTtsLanguageCompatibilityWarnings({
      model: 'kokoro', configuredLanguage: 'auto', documentLanguage, voice: 'jf_alpha',
    })).toEqual([]);
  });

  test('maps Kokoro voices and normalized language tags to Replicate language codes', () => {
    expect(resolveReplicateKokoroLanguageCode({ language: 'en', voice: 'af_sarah' })).toBe('a');
    expect(resolveReplicateKokoroLanguageCode({ language: 'en', voice: 'bf_emma' })).toBe('b');
    expect(resolveReplicateKokoroLanguageCode({ language: 'ja-JP', voice: 'jf_alpha' })).toBe('j');
    expect(resolveReplicateKokoroLanguageCode({ language: 'zh-TW', voice: 'zf_xiaobei' })).toBe('z');
  });

  test.each([
    [{ configuredLanguage: 'de', documentLanguage: 'tr-TR', voice: 'jf_alpha' }, 'de'],
    [{ configuredLanguage: 'auto', documentLanguage: 'tr-TR', voice: 'jf_alpha' }, 'ja'],
    [{ configuredLanguage: 'auto', documentLanguage: 'tr-TR', voice: 'F1' }, 'tr-TR'],
    [{ configuredLanguage: 'auto', documentLanguage: 'de-DE', voice: 'alloy' }, 'de-DE'],
    [{ documentLanguage: 'fr', voice: 'custom-voice' }, 'fr'],
    [{ documentLanguage: 'tr', voice: 'ff_siwis+jf_alpha' }, 'tr'],
    [{ documentLanguage: 'en-US', voice: 'F1' }, 'en'],
    [{ documentLanguage: 'en-GB', voice: 'alloy' }, 'en'],
    [{ documentLanguage: null, voice: 'F1' }, 'en'],
    [{ documentLanguage: 'not_a_language', voice: 'F1' }, 'en'],
    [{ documentLanguage: 'auto', voice: 'F1' }, 'en'],
  ])('resolves configured, voice, metadata, then English: %j', (input, expected) => {
    expect(resolveTtsLanguage(input)).toBe(expected);
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

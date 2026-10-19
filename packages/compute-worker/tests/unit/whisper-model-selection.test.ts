import { describe, expect, test } from 'vitest';
import { resolveTtsLanguage } from '@openreader/tts/language';
import {
  getWhisperModelPaths,
  resolveWhisperModelVariant,
} from '../../src/inference/whisper/model';

describe('Whisper alignment model selection', () => {
  test('uses the English-only tiny model for English language tags', () => {
    expect(resolveWhisperModelVariant('en')).toBe('tiny-english');
    expect(resolveWhisperModelVariant('en-US')).toBe('tiny-english');
    expect(resolveWhisperModelVariant('EN_gb')).toBe('tiny-english');
  });

  test('uses the English-only tiny model when Auto cannot infer voice or document language', () => {
    const resolvedLanguage = resolveTtsLanguage({
      configuredLanguage: 'auto',
      voice: 'F1',
    });

    expect(resolvedLanguage).toBe('en');
    expect(resolveWhisperModelVariant(resolvedLanguage)).toBe('tiny-english');
  });

  test.each(['und', 'UND'])('treats %s document metadata as absent in Auto', (documentLanguage) => {
    expect(resolveTtsLanguage({ configuredLanguage: 'auto', voice: 'F1', documentLanguage })).toBe('en');
  });

  test('keeps the multilingual base model for other or unknown languages', () => {
    expect(resolveWhisperModelVariant('es')).toBe('base-multilingual');
    expect(resolveWhisperModelVariant('fr-CA')).toBe('base-multilingual');
    expect(resolveWhisperModelVariant()).toBe('base-multilingual');
  });

  test.each(['tr', 'tr-TR', 'de-DE'])('aligns Auto + F1 + %s metadata with the multilingual model', (documentLanguage) => {
    const language = resolveTtsLanguage({ configuredLanguage: 'auto', voice: 'F1', documentLanguage });
    expect(resolveWhisperModelVariant(language)).toBe('base-multilingual');
  });

  test('stores each model in its own durable artifact directory', () => {
    expect(getWhisperModelPaths('tiny-english').modelDir).toContain('whisper-tiny.en_timestamped');
    expect(getWhisperModelPaths('base-multilingual').modelDir).toContain('whisper-base_timestamped');
    expect(getWhisperModelPaths('tiny-english').modelDir)
      .not.toBe(getWhisperModelPaths('base-multilingual').modelDir);
  });
});

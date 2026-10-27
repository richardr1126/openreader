import { describe, expect, test } from 'vitest';
import { DEFAULT_SPEECH_TEXT, mapSpeechTextSegments, mapSpokenRange, remapSpeechAlignment } from '@openreader/tts/speech-text';
import { buildTtsSegmentSettingsHash } from '@openreader/tts/segments';

describe('speech-only text filtering', () => {
  test('disabled options preserve the identity path', () => {
    expect(mapSpeechTextSegments([{ ordinal: 0, text: 'A [1] (Smith, 2024).' }], DEFAULT_SPEECH_TEXT, () => 'one').size).toBe(0);
  });
  test.each([
    ['A [1, 3–5] result (Smith, 2024).', 'A result.'],
    ['A (Smith et al., 2024; García, 2022) result.', 'A result.'],
    ['Year 2024 (42) [ordinary prose] stays.', 'Year 2024 (42) [ordinary prose] stays.'],
  ])('citations: %s', (text, expected) => {
    const result = mapSpeechTextSegments([{ ordinal: 0, text }], { citations: true, brackets: 'off' }, () => 'one');
    expect(result.get(0)?.text ?? text).toBe(expected);
  });
  test('nested bracketed prose and repeated words retain exact source offsets', () => {
    const text = 'The [the (the)] the answer.';
    const mapping = mapSpeechTextSegments([{ ordinal: 0, text }], { citations: false, brackets: 'square' }, () => 'one').get(0)!;
    expect(mapping.text).toBe('The the answer.');
    expect(mapSpokenRange(mapping, 4, 7)).toEqual([16, 19]);
  });
  test('brackets span segments but never suppress later sections', () => {
    const segments = ['A [note.', 'More note.', 'End] B.', '[unclosed.', 'Later chapter.'].map((text, ordinal) => ({ text, ordinal }));
    const mapped = mapSpeechTextSegments(segments, { citations: false, brackets: 'square' }, (segment) => segment.ordinal < 4 ? 'one' : 'two');
    expect(mapped.get(0)?.text).toBe('A');
    expect(mapped.get(1)?.text).toBe('');
    expect(mapped.get(2)?.text).toBe('B.');
    expect(mapped.has(3)).toBe(false);
    expect(mapped.has(4)).toBe(false);
  });
  test('parentheses are independent of square brackets and citations', () => {
    const text = 'A (aside) [note] B.';
    expect(mapSpeechTextSegments([{ ordinal: 0, text }], { citations: false, brackets: 'parentheses' }, () => 'one').get(0)?.text).toBe('A [note] B.');
    expect(mapSpeechTextSegments([{ ordinal: 0, text }], { citations: false, brackets: 'both' }, () => 'one').get(0)?.text).toBe('A B.');
  });
  test('alignment and cache variants preserve released identity when disabled', () => {
    const source = 'The [the] the answer.';
    const mapping = mapSpeechTextSegments([{ ordinal: 0, text: source }], { citations: false, brackets: 'both' }, () => 'one').get(0)!;
    expect(remapSpeechAlignment(source, mapping, { sentenceIndex: 0, sentence: mapping.text,
      words: [{ text: 'the', startSec: 0, endSec: 1, charStart: 4, charEnd: 7 }] }).words[0]).toMatchObject({ charStart: 10, charEnd: 13 });
    const settings = { providerRef: 'openai', providerType: 'openai' as const, ttsModel: 'tts-1', voice: 'alloy', nativeSpeed: 1 };
    expect(buildTtsSegmentSettingsHash({ ...settings, speechText: DEFAULT_SPEECH_TEXT })).toBe(buildTtsSegmentSettingsHash(settings));
    expect(buildTtsSegmentSettingsHash({ ...settings, speechText: { citations: true, brackets: 'off' } })).not.toBe(buildTtsSegmentSettingsHash(settings));
  });
});

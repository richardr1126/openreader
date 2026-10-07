import { describe, expect, test } from 'vitest';
import {
  describePendingVoiceChanges,
  formatVoiceDockLabel,
  groupVoices,
  pendingVoiceSettings,
  selectedVoicesFor,
  toggleDraftVoice,
  voiceStringFor,
} from '@/lib/client/tts/voice-draft';
import { buildVoicePreviewText, truncateVoicePreviewText } from '@/lib/shared/tts-voice-preview';

const MULTI = { multi: true, maxVoices: 2 };
const SINGLE = { multi: false, maxVoices: 1 };

describe('voice draft', () => {
  test('dock label shows model speed only when supported and not 1x', () => {
    expect(formatVoiceDockLabel({ voice: 'af_heart', nativeSpeed: 1.1, supportsNativeModelSpeed: true }))
      .toBe('af_heart · 1.1x');
    expect(formatVoiceDockLabel({ voice: 'af_heart', nativeSpeed: 1, supportsNativeModelSpeed: true })).toBe('af_heart');
    expect(formatVoiceDockLabel({ voice: 'alloy', nativeSpeed: 1.5, supportsNativeModelSpeed: false })).toBe('alloy');
    expect(formatVoiceDockLabel({ voice: 'af_heart(0.5)+af_bella(0.5)', nativeSpeed: 1, supportsNativeModelSpeed: true }))
      .toBe('af_heart + af_bella');
  });

  test('describes and isolates only what changed', () => {
    const applied = { voice: 'af_heart', nativeSpeed: 1 };
    expect(pendingVoiceSettings(applied, applied)).toBeNull();
    expect(pendingVoiceSettings(applied, { voice: 'af_bella', nativeSpeed: 1 })).toEqual({ voice: 'af_bella' });
    expect(describePendingVoiceChanges(applied, { voice: 'af_bella', nativeSpeed: 1.1 })).toEqual([
      'Voice af_heart → af_bella',
      'Speed 1x → 1.1x',
    ]);
  });

  test('single-voice providers replace the selection', () => {
    expect(toggleDraftVoice(['alloy'], 'echo', SINGLE)).toEqual(['echo']);
    expect(voiceStringFor(['echo'], SINGLE)).toBe('echo');
  });

  test('Kokoro mixes keep one language and drop the oldest pick past the limit', () => {
    expect(toggleDraftVoice(['af_heart'], 'af_bella', MULTI)).toEqual(['af_heart', 'af_bella']);
    expect(toggleDraftVoice(['af_heart', 'af_bella'], 'am_adam', MULTI)).toEqual(['af_bella', 'am_adam']);
    // A pick in another language replaces the mix.
    expect(toggleDraftVoice(['af_heart', 'af_bella'], 'jf_alpha', MULTI)).toEqual(['jf_alpha']);
    // Toggling off keeps at least one voice.
    expect(toggleDraftVoice(['af_heart', 'af_bella'], 'af_heart', MULTI)).toEqual(['af_bella']);
    expect(toggleDraftVoice(['af_heart'], 'af_heart', MULTI)).toEqual(['af_heart']);
    expect(voiceStringFor(['af_heart', 'af_bella'], MULTI)).toBe('af_heart(0.5)+af_bella(0.5)');
    expect(selectedVoicesFor('af_heart(0.5)+af_bella(0.5)', [], MULTI)).toEqual(['af_heart', 'af_bella']);
  });

  test('groups Kokoro voices by language and searches names and languages', () => {
    const voices = ['af_heart', 'bf_emma', 'jf_alpha', 'af_bella'];
    expect(groupVoices(voices, '', true).map((group) => [group.label, group.voices])).toEqual([
      ['American English', ['af_heart', 'af_bella']],
      ['British English', ['bf_emma']],
      ['Japanese', ['jf_alpha']],
    ]);
    expect(groupVoices(voices, 'japan', true).flatMap((group) => group.voices)).toEqual(['jf_alpha']);
    expect(groupVoices(['alloy', 'echo'], 'ech', false)).toEqual([{ key: 'all', label: 'Voices', voices: ['echo'] }]);
  });
});

describe('voice preview text', () => {
  test('speaks the current sentence, trimmed to a word boundary', () => {
    const sentence = `${'word '.repeat(60)}end.`;
    const text = buildVoicePreviewText({ currentSentence: sentence, documentLanguage: 'en', voice: 'af_heart' });
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.endsWith('word')).toBe(true);
    expect(truncateVoicePreviewText('Short sentence.')).toBe('Short sentence.');
  });

  test('falls back to a sample in the voice language when it differs from the document', () => {
    expect(buildVoicePreviewText({ currentSentence: 'Hello there.', documentLanguage: 'en', voice: 'jf_alpha' }))
      .toMatch(/[ぁ-んァ-ン一-龯]/u);
    expect(buildVoicePreviewText({ currentSentence: '', documentLanguage: 'fr', voice: 'alloy' }))
      .toContain('histoire');
    expect(buildVoicePreviewText({ currentSentence: 'Hello there.', documentLanguage: 'auto', voice: 'jf_alpha' }))
      .toBe('Hello there.');
  });
});

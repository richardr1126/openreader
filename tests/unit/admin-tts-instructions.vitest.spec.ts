import { describe, expect, test } from 'vitest';

import { resolveEffectiveTtsInstructions } from '../../src/lib/server/admin/tts-instructions';

describe('resolveEffectiveTtsInstructions', () => {
  test('uses explicit request instructions when model supports them', () => {
    const out = resolveEffectiveTtsInstructions({
      model: 'gpt-4o-mini-tts',
      requestInstructions: 'Speak quickly.',
      sharedDefaultInstructions: 'Default style',
    });

    expect(out).toBe('Speak quickly.');
  });

  test('falls back to shared default instructions when request value is missing', () => {
    const out = resolveEffectiveTtsInstructions({
      model: 'gpt-4o-mini-tts',
      requestInstructions: '',
      sharedDefaultInstructions: 'Warm, conversational tone',
    });

    expect(out).toBe('Warm, conversational tone');
  });

  test('trims whitespace-only values and returns undefined when both are empty', () => {
    const out = resolveEffectiveTtsInstructions({
      model: 'gpt-4o-mini-tts',
      requestInstructions: '   ',
      sharedDefaultInstructions: '\n\t',
    });

    expect(out).toBeUndefined();
  });

  test('returns undefined for models that do not support instructions', () => {
    const out = resolveEffectiveTtsInstructions({
      model: 'kokoro',
      requestInstructions: 'Use emphasis',
      sharedDefaultInstructions: 'Default',
    });

    expect(out).toBeUndefined();
  });
});


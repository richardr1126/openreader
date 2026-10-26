import { describe, expect, test } from 'vitest';

import { resolveEffectiveTtsInstructions } from '@openreader/tts/instructions';

describe('resolveEffectiveTtsInstructions', () => {
  test.each(['s2-pro', 's2.1-pro', 's2.1-pro-free', 'drama-3'])('retains Fish %s request and shared directions', model => {
    expect(resolveEffectiveTtsInstructions({ model, requestInstructions: 'Calm', sharedDefaultInstructions: 'Warm' })).toBe('Calm');
    expect(resolveEffectiveTtsInstructions({ model, sharedDefaultInstructions: 'Warm' })).toBe('Warm');
  });
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


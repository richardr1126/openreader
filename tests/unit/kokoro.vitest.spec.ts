import { describe, expect, test } from 'vitest';

import { getMaxVoicesForProvider } from '@openreader/tts/kokoro';

describe('kokoro voice limits', () => {
  test('keeps Replicate single-voice even for Kokoro models', () => {
    expect(getMaxVoicesForProvider('replicate', 'kokoro')).toBe(1);
    expect(getMaxVoicesForProvider('replicate', 'hexgrad/Kokoro-82M')).toBe(1);
  });

  test('allows multiple Kokoro voices on compatible servers', () => {
    expect(getMaxVoicesForProvider('custom-openai', 'kokoro')).toBe(Infinity);
  });

  test('non-kokoro models are always single-voice', () => {
    expect(getMaxVoicesForProvider('replicate', 'google/gemini-3.1-flash-tts')).toBe(1);
    expect(getMaxVoicesForProvider('openai', 'gpt-4o-mini-tts')).toBe(1);
  });
});


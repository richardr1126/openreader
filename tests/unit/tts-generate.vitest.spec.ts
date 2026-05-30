import { describe, expect, test } from 'vitest';

import { extractReplicateAudioUrl } from '../../src/lib/server/tts/generate';

describe('replicate output URL extraction', () => {
  test('returns direct URL string output', () => {
    expect(extractReplicateAudioUrl('https://replicate.delivery/audio.mp3')).toBe(
      'https://replicate.delivery/audio.mp3'
    );
  });

  test('extracts URL from FileOutput-like objects', () => {
    const output = {
      url: () => new URL('https://replicate.delivery/file.wav'),
    };
    expect(extractReplicateAudioUrl(output)).toBe('https://replicate.delivery/file.wav');
  });

  test('extracts first URL from array outputs', () => {
    const output: unknown[] = [
      { value: 'not-a-url' },
      { toString: () => 'https://replicate.delivery/chunk-0.mp3' },
      'https://replicate.delivery/chunk-1.mp3',
    ];
    expect(extractReplicateAudioUrl(output)).toBe('https://replicate.delivery/chunk-0.mp3');
  });

  test('extracts nested URL from object outputs', () => {
    const output = {
      output: {
        audio: {
          url: 'https://replicate.delivery/nested.mp3',
        },
      },
    };
    expect(extractReplicateAudioUrl(output)).toBe('https://replicate.delivery/nested.mp3');
  });

  test('returns null for non-url outputs', () => {
    const output = { status: 'ok', value: 123 };
    expect(extractReplicateAudioUrl(output)).toBeNull();
  });
});

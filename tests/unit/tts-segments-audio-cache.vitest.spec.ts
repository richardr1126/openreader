import { describe, expect, test } from 'vitest';
import {
  buildSegmentAudioCacheHeaders,
  normalizeAudioByteRangeHeader,
  TTS_SEGMENT_AUDIO_VARY,
  TTS_SEGMENT_FALLBACK_CACHE_CONTROL,
} from '../../src/lib/server/tts/segments-audio';

describe('tts segment audio cache headers', () => {
  test('builds fallback cache headers', () => {
    expect(buildSegmentAudioCacheHeaders()).toEqual({
      'Cache-Control': TTS_SEGMENT_FALLBACK_CACHE_CONTROL,
      Vary: TTS_SEGMENT_AUDIO_VARY,
    });
  });

  test('normalizes valid byte range header', () => {
    expect(normalizeAudioByteRangeHeader('bytes=0-1023')).toBe('bytes=0-1023');
    expect(normalizeAudioByteRangeHeader(' bytes=2048- ')).toBe('bytes=2048-');
    expect(normalizeAudioByteRangeHeader('bytes=-512')).toBe('bytes=-512');
  });

  test('rejects invalid byte range header', () => {
    expect(normalizeAudioByteRangeHeader(null)).toBeNull();
    expect(normalizeAudioByteRangeHeader('')).toBeNull();
    expect(normalizeAudioByteRangeHeader('items=0-10')).toBeNull();
    expect(normalizeAudioByteRangeHeader('bytes=-')).toBeNull();
    expect(normalizeAudioByteRangeHeader('bytes=20-10')).toBeNull();
    expect(normalizeAudioByteRangeHeader('bytes=abc-def')).toBeNull();
  });
});

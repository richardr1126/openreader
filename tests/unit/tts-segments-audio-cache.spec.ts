import { expect, test } from '@playwright/test';
import {
  buildSegmentAudioCacheHeaders,
  TTS_SEGMENT_AUDIO_VARY,
  TTS_SEGMENT_FALLBACK_CACHE_CONTROL,
  TTS_SEGMENT_REDIRECT_CACHE_CONTROL,
} from '../../src/lib/server/tts/segments-audio';

test.describe('tts segment audio cache headers', () => {
  test('builds redirect cache headers', () => {
    expect(buildSegmentAudioCacheHeaders('redirect')).toEqual({
      'Cache-Control': TTS_SEGMENT_REDIRECT_CACHE_CONTROL,
      Vary: TTS_SEGMENT_AUDIO_VARY,
    });
  });

  test('builds fallback cache headers', () => {
    expect(buildSegmentAudioCacheHeaders('fallback')).toEqual({
      'Cache-Control': TTS_SEGMENT_FALLBACK_CACHE_CONTROL,
      Vary: TTS_SEGMENT_AUDIO_VARY,
    });
  });
});

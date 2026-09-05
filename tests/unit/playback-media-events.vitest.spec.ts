import { describe, expect, test, vi } from 'vitest';
import { installPlaybackMediaEvents } from '@/lib/client/tts/playback-media-events';

describe('playback media event policy', () => {
  test('tears down the current stream on ended even after play intent is cleared', () => {
    const audio = { paused: false } as HTMLAudioElement;
    const onEnded = vi.fn();
    installPlaybackMediaEvents({
      audio,
      audioSpeed: 1,
      isCurrent: () => true,
      isPlaying: () => false,
      shouldRecoverEnd: () => false,
      onPause: vi.fn(),
      onBuffering: vi.fn(),
      onRecover: vi.fn(),
      onEnded,
      onTime: vi.fn(),
      onPlaying: vi.fn(),
    });
    audio.onended?.(new Event('ended'));
    expect(onEnded).toHaveBeenCalledOnce();
  });
});

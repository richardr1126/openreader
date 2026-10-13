import { describe, expect, test, vi } from 'vitest';
import { installPlaybackMediaEvents } from '@/lib/client/tts/playback-media-events';

describe('playback media event policy', () => {
  test('tears down the current stream on ended even after play intent is cleared', () => {
    const audio = { paused: false } as HTMLAudioElement;
    const onEnded = vi.fn();
    installPlaybackMediaEvents({
      audio,
      isCurrent: () => true,
      isPlaying: () => false,
      shouldRecoverEnd: () => false,
      reachedEnd: () => false,
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

  test('ends once at the real end of the document instead of playing the length padding', () => {
    const audio = { paused: false, pause: vi.fn() } as unknown as HTMLAudioElement;
    let realEnd = false;
    const onEnded = vi.fn();
    const onPause = vi.fn();
    installPlaybackMediaEvents({
      audio,
      isCurrent: () => true,
      isPlaying: () => true,
      shouldRecoverEnd: () => false,
      reachedEnd: () => realEnd,
      onPause,
      onBuffering: vi.fn(),
      onRecover: vi.fn(),
      onEnded,
      onTime: vi.fn(),
      onPlaying: vi.fn(),
    });
    audio.ontimeupdate?.(new Event('timeupdate'));
    expect(onEnded).not.toHaveBeenCalled();

    realEnd = true;
    audio.ontimeupdate?.(new Event('timeupdate'));
    audio.onpause?.(new Event('pause'));
    audio.onended?.(new Event('ended'));
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(onEnded).toHaveBeenCalledOnce();
    expect(onPause).not.toHaveBeenCalled();
  });

  test('a late ended event cannot reopen playback that already finished', () => {
    const audio = { paused: false, pause: vi.fn() } as unknown as HTMLAudioElement;
    const onEnded = vi.fn();
    const onRecover = vi.fn();
    installPlaybackMediaEvents({
      audio,
      isCurrent: () => true,
      isPlaying: () => true,
      shouldRecoverEnd: () => true,
      reachedEnd: () => true,
      onPause: vi.fn(),
      onBuffering: vi.fn(),
      onRecover,
      onEnded,
      onTime: vi.fn(),
      onPlaying: vi.fn(),
    });
    audio.ontimeupdate?.(new Event('timeupdate'));
    audio.onended?.(new Event('ended'));
    expect(onEnded).toHaveBeenCalledOnce();
    expect(onRecover).not.toHaveBeenCalled();
  });
});

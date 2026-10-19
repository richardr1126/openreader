import { describe, expect, test } from 'vitest';
import {
  isPlaybackBufferReady,
  measurePlaybackBuffer,
  PLAYBACK_RECOVERY_BUFFER_WALL_MS,
} from '@openreader/tts/playback-buffer';

describe('playback ahead buffer', () => {
  const segments = [
    { ordinal: 4, durationMs: 3_000, generated: true },
    { ordinal: 5, durationMs: 8_000, generated: true },
    { ordinal: 6, durationMs: 20_000, generated: false },
  ];

  test('counts contiguous generated audio from the cursor and subtracts its offset', () => {
    expect(measurePlaybackBuffer({
      segments,
      startOrdinal: 4,
      offsetWithinStartSegmentMs: 1_000,
      playbackRate: 1,
    })).toMatchObject({ durationMs: 10_000, wallMs: 10_000, segmentCount: 2 });
  });

  test('scales runway by playback rate and stops at a cache hole', () => {
    const buffer = measurePlaybackBuffer({ segments, startOrdinal: 4, playbackRate: 2 });
    expect(buffer.wallMs).toBe(5_500);
    expect(buffer.reachedDocumentEnd).toBe(false);
    expect(isPlaybackBufferReady({
      segments,
      startOrdinal: 4,
      playbackRate: 1,
      minimumWallMs: PLAYBACK_RECOVERY_BUFFER_WALL_MS,
    })).toBe(false);
  });

  test('plays through a failed sentence as its silent slot', () => {
    const withFailure = [
      segments[0],
      { ordinal: 5, durationMs: 8_000, generated: false, audioState: 'error' },
      segments[2],
    ];
    expect(measurePlaybackBuffer({ segments: withFailure, startOrdinal: 4 }))
      .toMatchObject({ durationMs: 11_000, segmentCount: 2 });
    expect(measurePlaybackBuffer({ segments: withFailure, startOrdinal: 5 }))
      .toMatchObject({ durationMs: 8_000, segmentCount: 1 });
  });
});

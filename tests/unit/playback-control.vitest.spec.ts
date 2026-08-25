import { describe, expect, test } from 'vitest';

import {
  isPlaybackAbortError,
  isPlaybackStartBufferReady,
  measurePlaybackStartBuffer,
  resolvePlaybackControlPresentation,
  waitForPlaybackStartBuffer,
} from '../../src/lib/client/tts/playback-control';

describe('playback request cancellation', () => {
  test('recognizes aborts without swallowing ordinary playback failures', () => {
    expect(isPlaybackAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true);
    expect(isPlaybackAbortError({ message: 'request canceled' })).toBe(true);
    expect(isPlaybackAbortError(new Error('provider failed'))).toBe(false);
  });
});

describe('playback control presentation', () => {
  test('does not claim playback is audible while planning or buffering', () => {
    expect(resolvePlaybackControlPresentation(true, 'planning')).toEqual({
      isPending: true,
      ariaLabel: 'Cancel playback loading',
      statusText: 'Preparing audio…',
    });
    expect(resolvePlaybackControlPresentation(true, 'buffering')).toEqual({
      isPending: true,
      ariaLabel: 'Cancel playback loading',
      statusText: 'Loading audio…',
    });
  });

  test('shows pause only after the media element emits playing', () => {
    expect(resolvePlaybackControlPresentation(true, 'playing')).toEqual({
      isPending: false,
      ariaLabel: 'Pause',
      statusText: null,
    });
  });
});

describe('playback start buffer', () => {
  const segment = (ordinal: number, durationMs: number, generated = true) => ({
    ordinal,
    durationMs,
    generated,
  });

  test('measures only contiguous generated audio from the requested ordinal', () => {
    expect(measurePlaybackStartBuffer([
      segment(8, 2_000),
      segment(9, 3_000),
      segment(10, 4_000, false),
      segment(11, 8_000),
    ], 8)).toEqual({
      durationMs: 5_000,
      segmentCount: 2,
      reachedDocumentEnd: false,
    });
  });

  test('waits for enough real audio instead of starting from one short segment', () => {
    expect(isPlaybackStartBufferReady({
      segments: [
        segment(20, 1_500),
        segment(21, 1_800),
        segment(22, 2_400),
        segment(23, 9_700, false),
      ],
      startOrdinal: 20,
      playbackRate: 1,
    })).toBe(false);
    expect(isPlaybackStartBufferReady({
      segments: [
        segment(20, 1_500),
        segment(21, 1_800),
        segment(22, 2_400),
        segment(23, 9_700),
      ],
      startOrdinal: 20,
      playbackRate: 1,
    })).toBe(true);
  });

  test('scales the media buffer for playback speed and permits a short document tail', () => {
    const buffered = [segment(30, 6_000), segment(31, 6_000), segment(32, 9_000, false)];
    expect(isPlaybackStartBufferReady({
      segments: buffered,
      startOrdinal: 30,
      playbackRate: 2,
    })).toBe(false);
    expect(isPlaybackStartBufferReady({
      segments: [segment(32, 3_000)],
      startOrdinal: 32,
      playbackRate: 2,
    })).toBe(true);
  });

  test('discounts audio before an in-segment seek target', () => {
    expect(isPlaybackStartBufferReady({
      segments: [segment(40, 12_000), segment(41, 4_000), segment(42, 4_000, false)],
      startOrdinal: 40,
      playbackRate: 1,
      offsetWithinStartSegmentMs: 8_000,
    })).toBe(false);
  });

  test('waits through partial layouts and stops when the requested run is replaced', async () => {
    const layouts = [
      {
        status: 'running',
        generationStartOrdinal: 50,
        segments: [segment(50, 2_000), segment(51, 9_000, false)],
      },
      {
        status: 'running',
        generationStartOrdinal: 50,
        segments: [segment(50, 2_000), segment(51, 9_000)],
      },
    ];
    expect(await waitForPlaybackStartBuffer({
      loadLayout: async () => layouts.shift() ?? null,
      isCurrent: () => true,
      playbackRate: 1,
      pollMs: 0,
    })).toEqual({
      status: 'running',
      generationStartOrdinal: 50,
      segments: [segment(50, 2_000), segment(51, 9_000)],
    });
    expect(await waitForPlaybackStartBuffer({
      loadLayout: async () => null,
      isCurrent: () => false,
      playbackRate: 1,
      pollMs: 0,
    })).toBeNull();
  });
});

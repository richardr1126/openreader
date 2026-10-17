import { describe, expect, test } from 'vitest';

import {
  canSkipInPlaybackPhase,
  PLAYBACK_START_BUFFER_WALL_MS,
  playbackStartProgress,
  isPlaybackAbortError,
  isPlaybackPhaseProcessing,
  isPlaybackStartBufferReady,
  measurePlaybackStartBuffer,
  resumePlaybackMedia,
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

describe('playback media resume', () => {
  test('reconnects only a stale resume that still owns playback intent', async () => {
    const staleError = new Error('media source disconnected');
    await expect(resumePlaybackMedia(
      () => Promise.reject(staleError),
      () => true,
    )).resolves.toEqual({ status: 'stale', error: staleError });

    await expect(resumePlaybackMedia(
      () => Promise.reject(staleError),
      () => false,
    )).resolves.toEqual({ status: 'cancelled' });

    await expect(resumePlaybackMedia(
      () => Promise.resolve(),
      () => true,
    )).resolves.toEqual({ status: 'resumed' });
  });
});

describe('playback control presentation', () => {
  test('derives processing from playback intent and lifecycle phase', () => {
    expect(isPlaybackPhaseProcessing(true, 'planning')).toBe(true);
    expect(isPlaybackPhaseProcessing(true, 'ready')).toBe(true);
    expect(isPlaybackPhaseProcessing(true, 'buffering')).toBe(true);
    expect(isPlaybackPhaseProcessing(true, 'seeking')).toBe(true);
    expect(isPlaybackPhaseProcessing(true, 'playing')).toBe(false);
    expect(isPlaybackPhaseProcessing(false, 'ready')).toBe(false);
    expect(isPlaybackPhaseProcessing(true, 'failed')).toBe(false);
  });

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

  test('starts from one long segment once it supplies the full time buffer', () => {
    expect(isPlaybackStartBufferReady({
      segments: [
        segment(20, 14_000),
        segment(21, 8_000, false),
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
        sessionId: 'session-current',
        status: 'running',
        generationStartOrdinal: 50,
        segments: [segment(50, 2_000), segment(51, 9_000, false)],
      },
      {
        sessionId: 'session-current',
        status: 'running',
        generationStartOrdinal: 50,
        segments: [segment(50, 2_000), segment(51, 9_000)],
      },
    ];
    expect(await waitForPlaybackStartBuffer({
      sessionId: 'session-current',
      loadLayout: async () => layouts.shift() ?? null,
      isCurrent: () => true,
      playbackRate: 1,
      pollMs: 0,
    })).toEqual({
      sessionId: 'session-current',
      status: 'running',
      generationStartOrdinal: 50,
      segments: [segment(50, 2_000), segment(51, 9_000)],
    });
    expect(await waitForPlaybackStartBuffer({
      sessionId: 'session-current',
      loadLayout: async () => null,
      isCurrent: () => false,
      playbackRate: 1,
      pollMs: 0,
    })).toBeNull();
  });

  test('ignores a ready layout from the previous playback session', async () => {
    const layouts = [
      {
        sessionId: 'session-previous',
        status: 'succeeded',
        generationStartOrdinal: 10,
        segments: [segment(10, 12_000)],
      },
      {
        sessionId: 'session-current',
        status: 'running',
        generationStartOrdinal: 40,
        segments: [segment(40, 12_000)],
      },
    ];

    await expect(waitForPlaybackStartBuffer({
      sessionId: 'session-current',
      loadLayout: async () => layouts.shift() ?? null,
      isCurrent: () => true,
      playbackRate: 1,
      pollMs: 0,
    })).resolves.toMatchObject({
      sessionId: 'session-current',
      generationStartOrdinal: 40,
    });
  });

  test('fails immediately when generation reaches a terminal failure', async () => {
    await expect(waitForPlaybackStartBuffer({
      sessionId: 'session-current',
      loadLayout: async () => ({
        sessionId: 'session-current',
        status: 'failed',
        generationStartOrdinal: 60,
        segments: [segment(60, 8_000, false)],
      }),
      isCurrent: () => true,
      playbackRate: 1,
      pollMs: 0,
    })).rejects.toThrow('TTS playback generation failed before audio became ready');
  });
});

describe('playback loading controls', () => {
  test('skips retarget while buffering but wait for session startup', () => {
    expect(canSkipInPlaybackPhase(false, 'ready')).toBe(true);
    expect(canSkipInPlaybackPhase(true, 'playing')).toBe(true);
    expect(canSkipInPlaybackPhase(true, 'buffering')).toBe(true);
    expect(canSkipInPlaybackPhase(true, 'seeking')).toBe(true);
    expect(canSkipInPlaybackPhase(true, 'planning')).toBe(false);
    expect(canSkipInPlaybackPhase(true, 'ready')).toBe(false);
  });

  test('fills the loading ring from the ready start buffer', () => {
    expect(playbackStartProgress(null)).toBe(0);
    expect(playbackStartProgress({ wallMs: PLAYBACK_START_BUFFER_WALL_MS / 2, reachedDocumentEnd: false })).toBe(0.5);
    expect(playbackStartProgress({ wallMs: PLAYBACK_START_BUFFER_WALL_MS * 3, reachedDocumentEnd: false })).toBe(1);
    expect(playbackStartProgress({ wallMs: 100, reachedDocumentEnd: true })).toBe(1);
  });
});

import { describe, expect, test, vi } from 'vitest';

import {
  PLAYBACK_START_BUFFER_WALL_MS,
  playbackStartProgress,
  isPlaybackAbortError,
  isPlaybackPhaseProcessing,
  isPlaybackStartBufferReady,
  measurePlaybackStartBuffer,
  resumePlaybackMedia,
  positionPlaybackMedia,
  resolvePlaybackControlPresentation,
  waitForPlaybackStartBuffer,
  createPlaybackReadinessDeadline,
  PLAYBACK_CURSOR_READ_LIMIT,
} from '../../src/lib/client/tts/playback-control';

describe('SSE readiness deadlines', () => {
  test('only new cached slots in the selected window extend idle time, within a hard cap', () => {
    let now = 0;
    const remaining = createPlaybackReadinessDeadline({ now: () => now });
    const slot = (ordinal: number) => ({ ordinal, durationMs: 20_000, generated: true });
    expect(remaining(10, 0, [])).toBe(60_000);
    now = 45_000;
    expect(remaining(10, 0, [slot(11)])).toBe(60_000);
    now = 70_000;
    // Repeated snapshots and another window's work are not progress.
    expect(remaining(10, 0, [slot(11), slot(9), slot(10 + PLAYBACK_CURSOR_READ_LIMIT)])).toBe(35_000);
    now = 100_000;
    expect(remaining(10, 0, [slot(11), slot(12)])).toBe(20_000);
    now = 120_000;
    expect(remaining(10, 0, [slot(11), slot(12), slot(13)])).toBe(0);
    // A new user target has its own bounded wait.
    expect(remaining(90, 0, [])).toBe(60_000);
  });
});

describe('playback request cancellation', () => {
  test('recognizes aborts without swallowing ordinary playback failures', () => {
    expect(isPlaybackAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true);
    expect(isPlaybackAbortError({ message: 'request canceled' })).toBe(true);
    expect(isPlaybackAbortError(new Error('provider failed'))).toBe(false);
    expect(isPlaybackAbortError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(false);
    expect(isPlaybackAbortError({ name: 'TimeoutError', message: 'The operation was aborted due to timeout' })).toBe(false);
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

describe('browser media positioning', () => {
  function audio() {
    return Object.assign(new EventTarget(), { currentTime: 0, readyState: 0, seeking: false }) as unknown as HTMLAudioElement;
  }
  test('waits for metadata and data before accepting the requested media time', async () => {
    const media = audio();
    let settled = false;
    const positioned = positionPlaybackMedia(media, 8, new AbortController().signal).then((result) => { settled = true; return result; });
    expect(media.currentTime).toBe(0);
    Object.defineProperty(media, 'readyState', { value: 1, writable: true });
    media.dispatchEvent(new Event('loadedmetadata'));
    expect(media.currentTime).toBe(8);
    await Promise.resolve();
    expect(settled).toBe(false);
    Object.defineProperty(media, 'readyState', { value: 2 });
    media.dispatchEvent(new Event('loadeddata'));
    await expect(positioned).resolves.toBe(true);
  });
  test('cancels a superseded source before late metadata can restore its position', async () => {
    const media = audio();
    const controller = new AbortController();
    const old = positionPlaybackMedia(media, 8, controller.signal);
    controller.abort();
    const current = positionPlaybackMedia(media, 2, new AbortController().signal);
    Object.defineProperty(media, 'readyState', { value: 2 });
    media.dispatchEvent(new Event('loadedmetadata'));
    await expect(old).resolves.toBe(false);
    await expect(current).resolves.toBe(true);
    expect(media.currentTime).toBe(2);
  });
  test('exposes browser positioning failure', async () => {
    const media = audio();
    Object.defineProperty(media, 'readyState', { value: 2 });
    Object.defineProperty(media, 'currentTime', { set() { throw new Error('rejected'); } });
    await expect(positionPlaybackMedia(media, 8, new AbortController().signal)).rejects.toThrow('rejected');
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

  test('startup still fails within its own readiness deadline when SSE never supplies audio', async () => {
    vi.useFakeTimers();
    try {
      const waiting = waitForPlaybackStartBuffer({
        sessionId: 'session-current', loadLayout: async () => null,
        isCurrent: () => true, playbackRate: 1,
      });
      const failed = expect(waiting).rejects.toThrow('did not buffer enough contiguous audio in time');
      await vi.advanceTimersByTimeAsync(60_500);
      await failed;
    } finally { vi.useRealTimers(); }
  });

  test('startup follows SSE generation progress while the target arrives after the original deadline', async () => {
    vi.useFakeTimers();
    try {
      let segments = [segment(0, 20_000, false), segment(1, 20_000, false)];
      let settled = false;
      const waiting = waitForPlaybackStartBuffer({
        sessionId: 'session-current', getStartOrdinal: () => 0,
        loadLayout: async () => ({ sessionId: 'session-current', status: 'running', generationStartOrdinal: 0, segments }),
        isCurrent: () => true, playbackRate: 1,
      }).then((value) => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(45_000);
      segments = [segment(0, 20_000, false), segment(1, 20_000)];
      await vi.advanceTimersByTimeAsync(25_000);
      expect(settled).toBe(false);
      segments = [segment(0, 20_000), segment(1, 20_000)];
      await vi.advanceTimersByTimeAsync(250);
      await expect(waiting).resolves.toMatchObject({ sessionId: 'session-current' });
    } finally { vi.useRealTimers(); }
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

  test('ignores the obsolete startup buffer after a seek redirects generation', async () => {
    vi.useFakeTimers();
    let target = 0;
    let release!: (layout: typeof oldLayout) => void;
    const oldLayout = {
      sessionId: 'session', status: 'running', generationStartOrdinal: 0,
      segments: [segment(0, 12_000), segment(1, 12_000, false), segment(2, 12_000, false)],
    };
    const loadLayout = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValue(oldLayout);
    try {
      let finished = false;
      const waiting = waitForPlaybackStartBuffer({
        sessionId: 'session', loadLayout, isCurrent: () => true, playbackRate: 1,
        getStartOrdinal: () => target,
      }).then((layout) => { finished = true; return layout; });
      target = 2;
      release(oldLayout);
      await vi.advanceTimersByTimeAsync(250);
      expect(finished).toBe(false);
      const newLayout = { ...oldLayout, segments: [segment(0, 12_000), segment(1, 12_000, false), segment(2, 12_000)] };
      loadLayout.mockResolvedValue(newLayout);
      await vi.advanceTimersByTimeAsync(250);
      await expect(waiting).resolves.toEqual(newLayout);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  test('does not accept a layout whose request completed after cancellation', async () => {
    let current = true;
    let release!: (layout: { sessionId: string; status: string; generationStartOrdinal: number; segments: ReturnType<typeof segment>[] }) => void;
    const waiting = waitForPlaybackStartBuffer({
      sessionId: 'session', isCurrent: () => current, playbackRate: 1,
      loadLayout: () => new Promise<Parameters<typeof release>[0]>((resolve) => { release = resolve; }),
    });
    current = false;
    release({ sessionId: 'session', status: 'running', generationStartOrdinal: 0, segments: [segment(0, 12_000)] });
    await expect(waiting).resolves.toBeNull();
  });
});

describe('playback loading controls', () => {
  test('fills the loading ring from the ready start buffer', () => {
    expect(playbackStartProgress(null)).toBe(0);
    expect(playbackStartProgress({ wallMs: PLAYBACK_START_BUFFER_WALL_MS / 2, reachedDocumentEnd: false })).toBe(0.5);
    expect(playbackStartProgress({ wallMs: PLAYBACK_START_BUFFER_WALL_MS * 3, reachedDocumentEnd: false })).toBe(1);
    expect(playbackStartProgress({ wallMs: 100, reachedDocumentEnd: true })).toBe(1);
  });
});

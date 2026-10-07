import { describe, expect, test } from 'vitest';

import {
  readyTimelineBands,
  scrubUndoTargetSec,
  timelineBandsGradient,
  timelineFraction,
} from '../../src/lib/client/tts/playback-timeline-track';
import {
  MEDIA_SESSION_DEFAULT_SEEK_OFFSET_SEC,
  mediaPositionState,
  mediaSeekOffsetTarget,
} from '../../src/hooks/audio/useMediaSession';

function segment(ordinal: number, startMs: number, endMs: number, generated: boolean) {
  return { ordinal, startMs, endMs, generated };
}

function layout(durationMs: number, segments: ReturnType<typeof segment>[]) {
  // Only the fields the track geometry reads.
  return { durationMs, segments } as unknown as Parameters<typeof readyTimelineBands>[0];
}

describe('playback timeline ready bands', () => {
  test('merges contiguous generated segments and leaves gaps for pending audio', () => {
    const bands = readyTimelineBands(layout(10_000, [
      segment(0, 0, 1_000, true),
      segment(1, 1_000, 2_500, true),
      segment(2, 2_500, 4_000, false),
      segment(3, 4_000, 5_000, true),
      segment(4, 5_001, 6_000, true),
      segment(5, 6_000, 10_000, false),
    ]));
    expect(bands).toEqual([
      { start: 0, end: 0.25 },
      { start: 0.4, end: 0.6 },
    ]);
  });

  test('is order-independent and clamps ranges to the document', () => {
    expect(readyTimelineBands(layout(1_000, [
      segment(1, 500, 1_200, true),
      segment(0, 0, 500, true),
    ]))).toEqual([{ start: 0, end: 1 }]);
  });

  test('has no bands without a layout, a duration, or generated audio', () => {
    expect(readyTimelineBands(null)).toEqual([]);
    expect(readyTimelineBands(layout(0, [segment(0, 0, 1_000, true)]))).toEqual([]);
    expect(readyTimelineBands(layout(1_000, [segment(0, 0, 1_000, false)]))).toEqual([]);
  });

  test('draws every band in one gradient with transparent gaps', () => {
    expect(timelineBandsGradient([], 'red')).toBeNull();
    expect(timelineBandsGradient([{ start: 0.1, end: 0.25 }], 'red')).toBe(
      'linear-gradient(to right, transparent 10.000%, red 10.000%, red 25.000%, transparent 25.000%)',
    );
  });

  test('heard fill is a clamped fraction of the document', () => {
    expect(timelineFraction(30, 120)).toBe(0.25);
    expect(timelineFraction(200, 120)).toBe(1);
    expect(timelineFraction(-1, 120)).toBe(0);
    expect(timelineFraction(10, 0)).toBe(0);
  });
});

describe('scrub undo target', () => {
  const doc = layout(9_000, [
    segment(0, 0, 3_000, true),
    segment(1, 3_000, 6_000, false),
    segment(2, 6_000, 9_000, false),
  ]);

  test('returns to the start of the sentence playing when the scrub began', () => {
    expect(scrubUndoTargetSec(doc, 4.2, 8)).toBe(3);
    expect(scrubUndoTargetSec(doc, 1.5, 9)).toBe(0);
  });

  test('offers nothing for a scrub that stayed in its sentence or without a layout', () => {
    expect(scrubUndoTargetSec(doc, 3.1, 5.9)).toBeNull();
    expect(scrubUndoTargetSec(null, 0, 8)).toBeNull();
  });
});

describe('media session position', () => {
  test('clamps into a state the Media Session API accepts', () => {
    expect(mediaPositionState({ positionSec: 130, durationSec: 120, playbackRate: 1.5 }))
      .toEqual({ duration: 120, position: 120, playbackRate: 1.5 });
    expect(mediaPositionState({ positionSec: -2, durationSec: 120, playbackRate: 0 }))
      .toEqual({ duration: 120, position: 0, playbackRate: 1 });
    expect(mediaPositionState({ positionSec: 5, durationSec: 0, playbackRate: 1 })).toBeNull();
  });

  test('seeks forward and backward by the requested or default offset', () => {
    expect(mediaSeekOffsetTarget(50, 120, 1, 30)).toBe(80);
    expect(mediaSeekOffsetTarget(50, 120, -1)).toBe(50 - MEDIA_SESSION_DEFAULT_SEEK_OFFSET_SEC);
    expect(mediaSeekOffsetTarget(115, 120, 1)).toBe(120);
    expect(mediaSeekOffsetTarget(3, 120, -1, null)).toBe(0);
  });
});

import { describe, expect, test } from 'vitest';
import {
  normalizePlaybackTimeline,
  projectTimelineAtTime,
  type TtsPlaybackTimeline,
} from '@/lib/client/tts/playback-timeline';

const timeline: TtsPlaybackTimeline = {
  sessionId: 'session-1',
  documentId: 'doc-1',
  status: 'running',
  startOrdinal: 0,
  durationMs: 3000,
  segments: [
    {
      ordinal: 0,
      sourceSegmentIndex: 0,
      segmentKey: 'a',
      segmentId: 'seg-a',
      startMs: 0,
      endMs: 1000,
      durationMs: 1000,
      locator: null,
      alignment: null,
    },
    {
      ordinal: 1,
      sourceSegmentIndex: 1,
      segmentKey: 'b',
      segmentId: 'seg-b',
      startMs: 1000,
      endMs: 3000,
      durationMs: 2000,
      locator: null,
      alignment: {
        sentenceIndex: 1,
        sentence: 'hello world',
        words: [
          { text: 'hello', startSec: 0, endSec: 0.5 },
          { text: 'world', startSec: 0.5, endSec: 1.2 },
        ],
      },
    },
  ],
};

describe('playback timeline mapping', () => {
  test('normalizes timeline payloads', () => {
    const normalized = normalizePlaybackTimeline({
      sessionId: 's',
      documentId: 'd',
      status: 'running',
      startOrdinal: 0,
      durationMs: 2000,
      segments: [
        { ordinal: 1, segmentKey: 'b', segmentId: 'b', startMs: 1000, endMs: 2000, durationMs: 1000 },
        { ordinal: 0, segmentKey: 'a', segmentId: 'a', startMs: 0, endMs: 1000, durationMs: 1000 },
      ],
    });
    expect(normalized.segments.map((segment) => segment.ordinal)).toEqual([0, 1]);
  });

  test('projects media time to segment and word position', () => {
    expect(projectTimelineAtTime(timeline, 0.25).segment?.segmentKey).toBe('a');
    const projected = projectTimelineAtTime(timeline, 1.75);
    expect(projected.segment?.segmentKey).toBe('b');
    expect(projected.localTimeSec).toBeCloseTo(0.75);
    expect(projected.wordIndex).toBe(1);
  });
});

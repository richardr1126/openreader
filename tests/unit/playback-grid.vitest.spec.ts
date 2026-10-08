import { describe, expect, test } from 'vitest';
import {
  documentTimeToMediaTime,
  mediaTimeToDocumentTime,
  mergePlaybackGrid,
  normalizePlaybackGrid,
  projectPlaybackGridAtTime,
  shouldRefreshPlaybackSegmentTiming,
  type TtsPlaybackGrid,
} from '@/lib/client/tts/playback-grid';

const grid: TtsPlaybackGrid = {
  sessionId: 'session-1',
  documentId: 'doc-1',
  status: 'running',
  startOrdinal: 0,
  generationStartOrdinal: 0,
  durationMs: 3000,
  segments: [
    {
      ordinal: 0,
      segmentKey: 'a',
      startMs: 0,
      endMs: 1000,
      durationMs: 1000,
      audioState: 'ready',
      durationSource: 'exact',
      generated: true,
      estimated: false,
      locator: null,
      alignment: null,
      alignmentSource: null,
    },
    {
      ordinal: 1,
      segmentKey: 'b',
      startMs: 1000,
      endMs: 3000,
      durationMs: 2000,
      audioState: 'ready',
      durationSource: 'exact',
      generated: true,
      estimated: false,
      locator: null,
      alignment: {
        sentenceIndex: 1,
        sentence: 'hello world',
        words: [
          { text: 'hello', startSec: 0, endSec: 0.5 },
          { text: 'world', startSec: 0.5, endSec: 1.2 },
        ],
      },
      alignmentSource: 'exact',
    },
  ],
};

describe('playback grid mapping', () => {
  test('merges a delayed cache overview without losing cursor audio or exact highlighting', () => {
    const priority = { ...grid, sessionUpdatedAt: 20, segments: [
      { ...grid.segments[0], generated: false, estimated: true, durationMs: 5000, endMs: 5000 },
      { ...grid.segments[1], startMs: 5000, endMs: 7000 },
    ] };
    const overview = { ...grid, status: 'queued', sessionUpdatedAt: 10, segments: [
      grid.segments[0], { ...grid.segments[1], generated: false, alignment: null, durationMs: 7000 },
    ] };
    const merged = mergePlaybackGrid(priority, overview);
    expect(merged.status).toBe('running');
    expect(merged.segments.map((segment) => segment.generated)).toEqual([true, true]);
    expect(merged.segments[1].startMs).toBe(1000);
    expect(merged.durationMs).toBe(3000);
    const anchorSec = merged.segments[1].startMs / 1000;
    expect(projectPlaybackGridAtTime(merged, mediaTimeToDocumentTime(0.75, anchorSec)).wordIndex).toBe(1);
    expect(mergePlaybackGrid(merged, { ...overview, sessionId: 'replacement' }).segments[1].generated).toBe(false);
    expect(mergePlaybackGrid(merged, { ...overview, status: 'canceled' }).segments[1].generated).toBe(false);
  });
  test('translates between a session-relative stream and whole-document time', () => {
    expect(mediaTimeToDocumentTime(2.5, 120)).toBe(122.5);
    expect(documentTimeToMediaTime(122.5, 120)).toBe(2.5);
    expect(documentTimeToMediaTime(80, 120)).toBe(0);
  });

  test('normalizes timeline payloads', () => {
    const normalized = normalizePlaybackGrid({
      sessionId: 's',
      documentId: 'd',
      status: 'running',
      startOrdinal: 0,
      generationStartOrdinal: 0,
      durationMs: 2000,
      segments: [
        { ordinal: 1, segmentKey: 'b', startMs: 1000, endMs: 2000, durationMs: 1000, generated: true, alignmentSource: null },
        { ordinal: 0, segmentKey: 'a', startMs: 0, endMs: 1000, durationMs: 1000, estimated: true },
      ],
    });
    expect(normalized.segments.map((segment) => segment.ordinal)).toEqual([0, 1]);
    expect(normalized.segments.map((segment) => segment.audioState)).toEqual(['pending', 'ready']);
    expect(normalized.segments.map((segment) => segment.durationSource)).toEqual(['estimated', 'exact']);
    expect(normalized.segments.map((segment) => segment.alignmentSource)).toEqual([null, null]);
    expect(shouldRefreshPlaybackSegmentTiming(normalized.segments[0])).toBe(true);
    expect(shouldRefreshPlaybackSegmentTiming(normalized.segments[1])).toBe(false);
    expect(shouldRefreshPlaybackSegmentTiming(grid.segments[1])).toBe(false);
  });

  test('projects media time to segment and word position', () => {
    expect(projectPlaybackGridAtTime(grid, 0.25).segment?.segmentKey).toBe('a');
    const projected = projectPlaybackGridAtTime(grid, 1.75);
    expect(projected.segment?.segmentKey).toBe('b');
    expect(projected.localTimeSec).toBeCloseTo(0.75);
    expect(projected.wordIndex).toBe(1);
  });
});

import { describe, expect, test } from 'vitest';
import {
  documentTimeToMediaTime,
  mediaTimeToDocumentTime,
  mergePlaybackGrid,
  normalizePlaybackGrid,
  projectPlaybackGridAtTime,
  type TtsPlaybackGrid,
} from '@/lib/client/tts/playback-grid';
import { isPlaybackSlotPlayable } from '@openreader/tts/playback-buffer';

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
  });

  test('treats a failed sentence as a playable silent slot', () => {
    const pending = { ...grid.segments[0], generated: false, audioState: 'pending' as const };
    expect(isPlaybackSlotPlayable(grid.segments[0])).toBe(true);
    expect(isPlaybackSlotPlayable(pending)).toBe(false);
    expect(isPlaybackSlotPlayable({ ...pending, audioState: 'error' })).toBe(true);
  });

  test('merges window-only rows onto the held grid', () => {
    const held = { ...grid, segments: [
      grid.segments[0],
      { ...grid.segments[1], generated: false, audioState: 'pending' as const, alignment: null },
      { ...grid.segments[0], ordinal: 2, segmentKey: 'c', startMs: 3000, endMs: 4000 },
    ] };
    const window = {
      ...grid,
      durationMs: 9999,
      readWindow: { minOrdinal: 1, limit: 1, rowsOnly: true },
      segments: [{ ...grid.segments[1], durationMs: 1500, startMs: 0, endMs: 1500 }],
    };
    const merged = mergePlaybackGrid(held, window);
    expect(merged.readWindow).toBeUndefined();
    expect(merged.segments.map((segment) => [segment.ordinal, segment.generated, segment.startMs])).toEqual([
      [0, true, 0], [1, true, 1000], [2, true, 2500],
    ]);
    expect(merged.durationMs).toBe(3500);
    const canceled = mergePlaybackGrid(merged, {
      ...window, status: 'canceled', segments: [{ ...held.segments[1], startMs: 0, endMs: 2000 }],
    });
    expect(canceled.segments.map((segment) => segment.generated)).toEqual([true, false, true]);
  });

  test('projects media time to segment and word position', () => {
    expect(projectPlaybackGridAtTime(grid, 0.25).segment?.segmentKey).toBe('a');
    const projected = projectPlaybackGridAtTime(grid, 1.75);
    expect(projected.segment?.segmentKey).toBe('b');
    expect(projected.localTimeSec).toBeCloseTo(0.75);
    expect(projected.wordIndex).toBe(1);
  });
});

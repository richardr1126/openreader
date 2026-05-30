import { describe, expect, test } from 'vitest';

import {
  completedEpubBoundarySegment,
  resolveEpubBoundaryHandoffStartIndex,
  resolveEpubReplaySuppressionAction,
  shouldSuppressCompletedEpubBoundaryReplay,
} from '../../src/lib/client/epub/tts-epub-handoff';
import type { CanonicalTtsSegment } from '../../src/lib/shared/tts-segment-plan';

const segment = (
  text: string,
  overrides: Partial<CanonicalTtsSegment> = {},
): CanonicalTtsSegment => ({
  key: `segment:${text}`,
  ordinal: 0,
  text,
  ownerSourceKey: 'str:page-a',
  ownerLocator: { location: 'page-a', readerType: 'epub' },
  startAnchor: { sourceKey: 'str:page-a', offset: 0 },
  endAnchor: { sourceKey: 'str:page-a', offset: text.length },
  spansSourceBoundary: false,
  ...overrides,
});

describe('EPUB boundary handoff', () => {
  test('records only completed segments that span a source boundary', () => {
    expect(completedEpubBoundarySegment(segment('same page'))).toBeNull();

    const completed = completedEpubBoundarySegment(segment('cross page', {
      spansSourceBoundary: true,
      endAnchor: { sourceKey: 'str:page-b', offset: 5 },
    }), 100);

    expect(completed).toMatchObject({
      key: 'segment:cross page',
      fingerprint: 'cross page',
      completedAt: 100,
    });
  });

  test('skips a leading replay of the completed boundary segment', () => {
    const completed = completedEpubBoundarySegment(segment('The same audio crosses the page.', {
      key: 'old-key',
      spansSourceBoundary: true,
      endAnchor: { sourceKey: 'str:page-b', offset: 10 },
    }), 1000);

    const startIndex = resolveEpubBoundaryHandoffStartIndex([
      segment('The same audio crosses the page.', { key: 'new-cfi-key' }),
      segment('Fresh audio on the next page.'),
    ], completed, 1100);

    expect(startIndex).toBe(1);
  });

  test('does not skip stale or non-leading matches', () => {
    const completed = completedEpubBoundarySegment(segment('Repeated later.', {
      spansSourceBoundary: true,
      endAnchor: { sourceKey: 'str:page-b', offset: 10 },
    }), 1000);

    expect(resolveEpubBoundaryHandoffStartIndex([
      segment('Fresh start.'),
      segment('Repeated later.'),
    ], completed, 1100)).toBe(0);

    expect(resolveEpubBoundaryHandoffStartIndex([
      segment('Repeated later.'),
    ], completed, 200_000)).toBe(0);
  });

  test('suppresses a completed boundary segment at playback time even if setText handoff missed it', () => {
    const completed = completedEpubBoundarySegment(segment('Boundary audio that already played.', {
      key: 'completed-key',
      spansSourceBoundary: true,
      endAnchor: { sourceKey: 'str:page-b', offset: 10 },
    }), 1000);

    expect(shouldSuppressCompletedEpubBoundaryReplay(
      segment('Boundary audio that already played.', { key: 'different-render-key' }),
      completed,
      1500,
    )).toBe(true);

    expect(shouldSuppressCompletedEpubBoundaryReplay(
      segment('Actually fresh audio.'),
      completed,
      1500,
    )).toBe(false);
  });

  test('suppression skips only within the current rendered segment list', () => {
    const completed = completedEpubBoundarySegment(segment('Boundary audio that already played.', {
      spansSourceBoundary: true,
      endAnchor: { sourceKey: 'str:page-b', offset: 10 },
    }), 1000);

    expect(resolveEpubReplaySuppressionAction([
      segment('Boundary audio that already played.', { key: 'rerendered-key' }),
      segment('Fresh local audio.'),
    ], 0, completed, 1100)).toEqual({ kind: 'skip-to-index', index: 1 });
  });

  test('suppression pauses instead of requesting another page turn when no fresh local segment exists', () => {
    const completed = completedEpubBoundarySegment(segment('Boundary audio that already played.', {
      spansSourceBoundary: true,
      endAnchor: { sourceKey: 'str:page-b', offset: 10 },
    }), 1000);

    expect(resolveEpubReplaySuppressionAction([
      segment('Boundary audio that already played.', { key: 'rerendered-key' }),
    ], 0, completed, 1100)).toEqual({ kind: 'pause' });
  });
});

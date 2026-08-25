import { describe, expect, test } from 'vitest';

import {
  isCfiWithinRenderedRange,
  isDirectionalEpubLocation,
  shouldPreserveEpubPlaybackCursor,
  shouldNavigateToDifferentCfi,
} from '../../src/lib/client/epub/location-controller';

describe('EPUB location controller helpers', () => {
  const compareCfi = (left: string, right: string) => Number(left) - Number(right);

  test('detects directional locations', () => {
    expect(isDirectionalEpubLocation('next')).toBe(true);
    expect(isDirectionalEpubLocation('prev')).toBe(true);
    expect(isDirectionalEpubLocation('epubcfi(/6/2!/4:0)')).toBe(false);
    expect(isDirectionalEpubLocation(4)).toBe(false);
  });

  test('navigates only when target CFI differs from rendered CFI', () => {
    expect(shouldNavigateToDifferentCfi('epubcfi(/6/4!/4:0)', 'epubcfi(/6/2!/4:0)')).toBe(true);
    expect(shouldNavigateToDifferentCfi('epubcfi(/6/2!/4:0)', 'epubcfi(/6/2!/4:0)')).toBe(false);
    expect(shouldNavigateToDifferentCfi('next', 'epubcfi(/6/2!/4:0)')).toBe(false);
    expect(shouldNavigateToDifferentCfi(3, 'epubcfi(/6/2!/4:0)')).toBe(false);
    expect(shouldNavigateToDifferentCfi('epubcfi(/6/4!/4:0)', undefined)).toBe(false);
  });

  test('recognizes a playback target already inside the rendered CFI range', () => {
    expect(isCfiWithinRenderedRange('15', '10', '20', compareCfi)).toBe(true);
    expect(isCfiWithinRenderedRange('10', '10', '20', compareCfi)).toBe(true);
    expect(isCfiWithinRenderedRange('20', '10', '20', compareCfi)).toBe(true);
    expect(isCfiWithinRenderedRange('21', '10', '20', compareCfi)).toBe(false);
    expect(isCfiWithinRenderedRange('15', undefined, '20', compareCfi)).toBe(false);
    expect(isCfiWithinRenderedRange('bad', '10', '20', () => {
      throw new Error('invalid CFI');
    })).toBe(false);
  });

  test('preserves the canonical cursor only for passive renderer and playback-follow placement', () => {
    expect(shouldPreserveEpubPlaybackCursor('initial')).toBe(false);
    expect(shouldPreserveEpubPlaybackCursor('manual')).toBe(false);
    expect(shouldPreserveEpubPlaybackCursor('renderer')).toBe(true);
    expect(shouldPreserveEpubPlaybackCursor('playback-follow')).toBe(true);
  });
});

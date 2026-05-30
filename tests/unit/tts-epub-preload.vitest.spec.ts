import { describe, expect, test } from 'vitest';

import type { CanonicalTtsSourceUnit } from '../../src/lib/shared/tts-segment-plan';
import {
  buildWalkerPlanningSourceUnits,
  selectUpcomingWalkerItems,
} from '../../src/lib/client/epub/tts-epub-preload';

describe('EPUB walker preload helpers', () => {
  test('selectUpcomingWalkerItems honors depth as current + (depth-1) upcoming', () => {
    const items = [
      { cfi: 'epubcfi(/6/2[;s=a]!/4/2)' }, // same as current after normalization
      { cfi: 'epubcfi(/6/4!/4/2)' },
      { cfi: 'epubcfi(/6/6!/4/2)' },
      { cfi: 'epubcfi(/6/8!/4/2)' },
    ];

    const selected = selectUpcomingWalkerItems(items, 'epubcfi(/6/2!/4/2)', 2);
    expect(selected.map((item) => item.cfi)).toEqual([
      'epubcfi(/6/4!/4/2)',
    ]);
  });

  test('selectUpcomingWalkerItems returns empty list when depth <= 1', () => {
    const items = [
      { cfi: 'epubcfi(/6/4!/4/2)' },
      { cfi: 'epubcfi(/6/6!/4/2)' },
    ];
    expect(selectUpcomingWalkerItems(items, 'epubcfi(/6/2!/4/2)', 1)).toEqual([]);
    expect(selectUpcomingWalkerItems(items, 'epubcfi(/6/2!/4/2)', 0)).toEqual([]);
  });

  test('buildWalkerPlanningSourceUnits includes live context', () => {
    const contextUnits: CanonicalTtsSourceUnit[] = [
      { sourceKey: 'previous:page-a', text: 'prev sentence', locator: null },
      { sourceKey: 'page-a', text: 'current sentence', locator: { readerType: 'epub', location: 'page-a' } },
    ];
    const upcomingUnits: CanonicalTtsSourceUnit[] = [
      { sourceKey: 'page-b', text: 'upcoming one', locator: { readerType: 'epub', location: 'page-b' } },
      { sourceKey: 'page-c', text: 'upcoming two', locator: { readerType: 'epub', location: 'page-c' } },
    ];

    const planned = buildWalkerPlanningSourceUnits(contextUnits, upcomingUnits);
    expect(planned.map((item) => item.sourceKey)).toEqual([
      'previous:page-a',
      'page-a',
      'page-b',
      'page-c',
    ]);
  });
});

import { describe, expect, test, vi } from 'vitest';

import {
  drainLatestNavigation,
  isCfiWithinRenderedRange,
  isDirectionalEpubLocation,
  shouldPreserveEpubPlaybackCursor,
  shouldNavigateToDifferentCfi,
} from '../../src/lib/client/epub/location-controller';
import {
  isRectPastViewport,
} from '../../src/lib/client/epub/epub-rendered-text-maps';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('EPUB location controller helpers', () => {
  test('serializes display work and lets the newest queued locator win', async () => {
    const firstResolution = deferred<string | null>();
    const firstDisplay = deferred<void>();
    const navigated: string[] = [];
    const state = { pending: 'first' as string | null, running: false };
    const resolve = vi.fn(async (target: string) => (
      target === 'first' ? firstResolution.promise : `cfi:${target}`
    ));
    const navigate = vi.fn(async (cfi: string, target: string) => {
      navigated.push(`${target}:${cfi}`);
      if (target === 'second') await firstDisplay.promise;
    });

    const run = drainLatestNavigation(state, resolve, navigate);
    state.pending = 'second';
    await drainLatestNavigation(state, resolve, navigate);
    firstResolution.resolve('cfi:first');
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigated).toEqual(['second:cfi:second']);

    state.pending = 'third';
    await drainLatestNavigation(state, resolve, navigate);
    firstDisplay.resolve();
    await run;

    expect(navigated).toEqual(['second:cfi:second', 'third:cfi:third']);
    expect(state).toEqual({ pending: null, running: false });
  });
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
    expect(shouldPreserveEpubPlaybackCursor('manual')).toBe(true);
    expect(shouldPreserveEpubPlaybackCursor('renderer')).toBe(true);
    expect(shouldPreserveEpubPlaybackCursor('playback-follow')).toBe(true);
  });
});

describe('EPUB spoken-word page follow', () => {
  const viewport = { left: 0, right: 800, bottom: 560 };
  const word = (left: number, top = 100) => ({ left, right: left + 40, top, width: 40, height: 18 });

  test('turns on a word laid out past the visible page', () => {
    expect(isRectPastViewport(word(760), viewport)).toBe(false);
    expect(isRectPastViewport(word(810), viewport)).toBe(true);
    expect(isRectPastViewport(word(100, 600), viewport)).toBe(true);
  });

  test('turns a right-to-left book on a word laid out to the left', () => {
    expect(isRectPastViewport(word(-120), viewport, 'rtl')).toBe(true);
    expect(isRectPastViewport(word(810), viewport, 'rtl')).toBe(false);
    expect(isRectPastViewport(word(100), viewport, 'rtl')).toBe(false);
  });

  test('ignores words with no layout', () => {
    expect(isRectPastViewport({ left: 900, right: 900, top: 0, width: 0, height: 0 }, viewport)).toBe(false);
  });
});

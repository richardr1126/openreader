import { describe, expect, test } from 'vitest';

import { shouldSyncPlaybackLocator } from '@/hooks/audio/usePlaybackProjection';

describe('playback locator projection', () => {
  test('navigates the renderer only when the projected locator changes', () => {
    expect(shouldSyncPlaybackLocator(undefined, 'epub|4|chapter.xhtml|120')).toBe(true);
    expect(shouldSyncPlaybackLocator(
      'epub|4|chapter.xhtml|120',
      'epub|4|chapter.xhtml|120',
    )).toBe(false);
    expect(shouldSyncPlaybackLocator(
      'epub|4|chapter.xhtml|120',
      'epub|4|chapter.xhtml|180',
    )).toBe(true);
    expect(shouldSyncPlaybackLocator('epub|4|chapter.xhtml|120', '')).toBe(false);
  });
});

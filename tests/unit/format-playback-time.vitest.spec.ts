import { describe, expect, it } from 'vitest';
import { formatPlaybackTime } from '@/lib/client/format-playback-time';

describe('formatPlaybackTime', () => {
  it.each([
    [0, '0:00'],
    [65, '1:05'],
    [3_599, '59:59'],
    [3_600, '1:00:00'],
    [46_923, '13:02:03'],
    [86_399, '23:59:59'],
    [86_400, '1d 00:00:00'],
    [176_523, '2d 01:02:03'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatPlaybackTime(seconds)).toBe(expected);
  });

  it('keeps invalid and negative values safe for display', () => {
    expect(formatPlaybackTime(-1)).toBe('0:00');
    expect(formatPlaybackTime(Number.NaN)).toBe('0:00');
    expect(formatPlaybackTime(Number.POSITIVE_INFINITY)).toBe('0:00');
  });

  it('displays only complete elapsed seconds', () => {
    expect(formatPlaybackTime(3_600.99)).toBe('1:00:00');
  });
});

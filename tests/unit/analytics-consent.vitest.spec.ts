import { describe, expect, test } from 'vitest';
import { isAnalyticsAllowed } from '@/lib/client/analytics';

describe('analytics consent', () => {
  test.each([
    ['undecided', false],
    ['declined', false],
    ['accepted', true],
  ] as const)('allows analytics for %s consent: %s', (consent, expected) => {
    expect(isAnalyticsAllowed(consent)).toBe(expected);
  });
});

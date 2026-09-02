import { describe, expect, test } from 'vitest';

import {
  IDLE_EPUB_PLACEMENT,
  readEpubCommittedLocation,
} from '@/lib/client/epub/plan-backed-placement';

describe('EPUB plan-backed placement lifecycle', () => {
  test('starts without pretending that a placement is ready', () => {
    expect(IDLE_EPUB_PLACEMENT).toEqual({ status: 'idle', error: null });
  });

  test('accepts only locations that EPUB.js has fully committed', () => {
    expect(readEpubCommittedLocation(undefined)).toBeNull();
    expect(readEpubCommittedLocation({ start: { cfi: 'start' } })).toBeNull();
    expect(readEpubCommittedLocation({
      start: { cfi: 'start' },
      end: { cfi: 'end' },
    })).toEqual({ startCfi: 'start', endCfi: 'end' });
  });
});

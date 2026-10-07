import { describe, expect, test } from 'vitest';
import {
  parseReadingPositionInput,
  readingPositionAt,
  resolveReadingPositionOrdinal,
} from '@/lib/shared/reading-position';

const plan = [
  { key: 'k0', ordinal: 0 },
  { key: 'k1', ordinal: 1 },
  { key: 'k2', ordinal: 2 },
  { key: 'k3', ordinal: 3 },
];

describe('resolveReadingPositionOrdinal', () => {
  test('keeps the hinted ordinal while its key still matches', () => {
    expect(resolveReadingPositionOrdinal(plan, { segmentKey: 'k2', segmentOrdinal: 2 })).toBe(2);
  });

  test('follows the content key after a re-plan shifted ordinals', () => {
    const shifted = [{ key: 'new', ordinal: 0 }, ...plan.map((s) => ({ ...s, ordinal: s.ordinal + 1 }))];
    expect(resolveReadingPositionOrdinal(shifted, { segmentKey: 'k2', segmentOrdinal: 2 })).toBe(3);
  });

  test('takes the first segment carrying the key', () => {
    const repeated = [...plan, { key: 'k1', ordinal: 4 }];
    expect(resolveReadingPositionOrdinal(repeated, { segmentKey: 'k1', segmentOrdinal: 9 })).toBe(1);
  });

  test('clamps the ordinal into the plan when the key is gone', () => {
    expect(resolveReadingPositionOrdinal(plan, { segmentKey: 'gone', segmentOrdinal: 2 })).toBe(2);
    expect(resolveReadingPositionOrdinal(plan, { segmentKey: 'gone', segmentOrdinal: 40 })).toBe(3);
    const gapped = [{ key: 'a', ordinal: 0 }, { key: 'b', ordinal: 5 }];
    expect(resolveReadingPositionOrdinal(gapped, { segmentKey: 'gone', segmentOrdinal: 3 })).toBe(5);
  });

  test('resolves a converted keyless position by ordinal alone', () => {
    expect(resolveReadingPositionOrdinal(plan, { segmentKey: null, segmentOrdinal: 1 })).toBe(1);
    expect(resolveReadingPositionOrdinal(plan, { segmentKey: null, segmentOrdinal: 99 })).toBe(3);
    expect(resolveReadingPositionOrdinal(plan, { segmentKey: null, segmentOrdinal: 0 })).toBe(0);
  });

  test('has no answer without a plan or a position', () => {
    expect(resolveReadingPositionOrdinal([], { segmentKey: 'k0', segmentOrdinal: 0 })).toBeNull();
    expect(resolveReadingPositionOrdinal(plan, null)).toBeNull();
  });
});

describe('reading progress round trip', () => {
  test('saves the cursor and restores it against the same plan', () => {
    const saved = readingPositionAt(plan, 2);
    expect(saved).toEqual({ segmentKey: 'k2', segmentOrdinal: 2, progress: 0.5 });
    const accepted = parseReadingPositionInput(JSON.parse(JSON.stringify(saved)));
    expect(accepted).toEqual({ segmentKey: 'k2', segmentOrdinal: 2 });
    expect(resolveReadingPositionOrdinal(plan, accepted)).toBe(2);
  });

  test('has no position for an ordinal outside the plan', () => {
    expect(readingPositionAt(plan, 9)).toBeNull();
  });

  test('rejects writes without a key or with an invalid ordinal', () => {
    expect(parseReadingPositionInput({ segmentOrdinal: 1 })).toBeNull();
    expect(parseReadingPositionInput({ segmentKey: ' ', segmentOrdinal: 1 })).toBeNull();
    expect(parseReadingPositionInput({ segmentKey: 'k', segmentOrdinal: -1 })).toBeNull();
    expect(parseReadingPositionInput({ segmentKey: 'k', segmentOrdinal: 1.5 })).toBeNull();
    expect(parseReadingPositionInput({ segmentKey: 'x'.repeat(513), segmentOrdinal: 1 })).toBeNull();
    expect(parseReadingPositionInput({ segmentKey: ' k ', segmentOrdinal: 1 }))
      .toEqual({ segmentKey: 'k', segmentOrdinal: 1 });
  });
});

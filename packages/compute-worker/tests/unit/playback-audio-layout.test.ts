import { describe, expect, test } from 'vitest';
import { STREAM_AUDIO_BYTES_PER_SECOND } from '@openreader/tts/audio-format';
import {
  DEFAULT_MS_PER_CHAR,
  bytesForDurationMs,
  buildByteLayout,
  calibrateMsPerChar,
  estimateDurationMs,
  locateByte,
  parseRangeHeader,
  type PlanSlotInput,
} from '../../src/api/playback-audio-layout';

// 128 kbps CBR ⇒ 16000 bytes/sec.
const BPS = STREAM_AUDIO_BYTES_PER_SECOND;

describe('CBR byte/time linearity', () => {
  test('bytesForDurationMs is linear and rounds, clamps non-positive', () => {
    expect(BPS).toBe(16000);
    expect(bytesForDurationMs(1000)).toBe(16000);
    expect(bytesForDurationMs(500)).toBe(8000);
    expect(bytesForDurationMs(0)).toBe(0);
    expect(bytesForDurationMs(-5)).toBe(0);
    expect(bytesForDurationMs(Number.NaN)).toBe(0);
  });
});

describe('duration estimation + calibration', () => {
  test('estimateDurationMs scales with trimmed char count', () => {
    expect(estimateDurationMs('', 50)).toBe(1); // floored to 1ms, never 0
    expect(estimateDurationMs('  hello  ', 10)).toBe(50); // 5 chars * 10
    expect(estimateDurationMs('abcd', 0)).toBe(4 * DEFAULT_MS_PER_CHAR); // bad rate → default
  });

  test('calibrateMsPerChar averages real samples, falls back when empty', () => {
    expect(calibrateMsPerChar([])).toBe(DEFAULT_MS_PER_CHAR);
    expect(calibrateMsPerChar([{ chars: 0, durationMs: 0 }])).toBe(DEFAULT_MS_PER_CHAR);
    // 100 chars → 5000ms and 50 chars → 2500ms ⇒ 50 ms/char overall.
    expect(calibrateMsPerChar([
      { chars: 100, durationMs: 5000 },
      { chars: 50, durationMs: 2500 },
    ])).toBe(50);
  });
});

describe('buildByteLayout', () => {
  const plan: PlanSlotInput[] = [
    { segmentIndex: 0, text: 'aaaaa', durationMs: 1000 }, // generated → exact
    { segmentIndex: 1, text: 'bbbbb', durationMs: 2000 }, // generated → exact
    { segmentIndex: 2, text: 'ccccc', durationMs: null }, // pending → estimated
  ];

  test('windows from startOrdinal and sizes slots from exact/estimated duration', () => {
    const layout = buildByteLayout(plan, 1, 50);
    expect(layout.slots.map((s) => s.segmentIndex)).toEqual([1, 2]);
    // slot 1: exact 2000ms → 32000 bytes; slot 2: 5 chars * 50ms = 250ms → 4000 bytes
    expect(layout.slots[0]).toMatchObject({ startByte: 0, byteLength: 32000, generated: true });
    expect(layout.slots[1]).toMatchObject({ startByte: 32000, byteLength: 4000, generated: false });
    expect(layout.totalBytes).toBe(36000);
  });

  test('whole window from ordinal 0 is contiguous with no gaps', () => {
    const layout = buildByteLayout(plan, 0, 50);
    let cursor = 0;
    for (const slot of layout.slots) {
      expect(slot.startByte).toBe(cursor);
      cursor += slot.byteLength;
    }
    expect(layout.totalBytes).toBe(cursor);
  });
});

describe('locateByte', () => {
  const layout = buildByteLayout(
    [
      { segmentIndex: 0, text: 'x', durationMs: 1000 }, // [0, 16000)
      { segmentIndex: 1, text: 'x', durationMs: 1000 }, // [16000, 32000)
      { segmentIndex: 2, text: 'x', durationMs: 1000 }, // [32000, 48000)
    ],
    0,
    50,
  );

  test('maps interior offsets to the right slot + offset within', () => {
    expect(locateByte(layout, 0)).toEqual({ slotIndex: 0, offsetWithin: 0 });
    expect(locateByte(layout, 16000)).toEqual({ slotIndex: 1, offsetWithin: 0 });
    expect(locateByte(layout, 20000)).toEqual({ slotIndex: 1, offsetWithin: 4000 });
    expect(locateByte(layout, 47999)).toEqual({ slotIndex: 2, offsetWithin: 15999 });
  });

  test('returns null at/after the end and for negatives', () => {
    expect(locateByte(layout, 48000)).toBeNull();
    expect(locateByte(layout, -1)).toBeNull();
  });
});

describe('parseRangeHeader', () => {
  const total = 1000;

  test('no header → null (serve full 200)', () => {
    expect(parseRangeHeader(undefined, total)).toBeNull();
    expect(parseRangeHeader('', total)).toBeNull();
  });

  test('open-ended and closed single ranges clamp to total', () => {
    expect(parseRangeHeader('bytes=0-', total)).toEqual({ start: 0, end: 999 });
    expect(parseRangeHeader('bytes=100-', total)).toEqual({ start: 100, end: 999 });
    expect(parseRangeHeader('bytes=100-199', total)).toEqual({ start: 100, end: 199 });
    expect(parseRangeHeader('bytes=100-5000', total)).toEqual({ start: 100, end: 999 });
  });

  test('suffix range returns the last N bytes', () => {
    expect(parseRangeHeader('bytes=-200', total)).toEqual({ start: 800, end: 999 });
    expect(parseRangeHeader('bytes=-5000', total)).toEqual({ start: 0, end: 999 });
  });

  test('beyond-resource start is unsatisfiable', () => {
    expect(parseRangeHeader('bytes=1000-', total)).toBe('unsatisfiable');
    expect(parseRangeHeader('bytes=2000-3000', total)).toBe('unsatisfiable');
  });

  test('malformed / multi-range / inverted → invalid (caller serves full)', () => {
    expect(parseRangeHeader('bytes=abc-def', total)).toBe('invalid');
    expect(parseRangeHeader('bytes=0-10,20-30', total)).toBe('invalid');
    expect(parseRangeHeader('bytes=-', total)).toBe('invalid');
    expect(parseRangeHeader('bytes=500-100', total)).toBe('invalid');
    expect(parseRangeHeader('kb=0-100', total)).toBe('invalid');
  });

  test('unknown total size is unsatisfiable for any range', () => {
    expect(parseRangeHeader('bytes=0-', 0)).toBe('unsatisfiable');
  });
});

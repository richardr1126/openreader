import { describe, expect, test } from 'vitest';
import { computeAdaptiveDecodeStepLimit, planAlignmentWindows } from '../../../src/inference/whisper/align';

const SAMPLE_RATE = 16000;
const WINDOW = 30 * SAMPLE_RATE;

describe('whisper alignment windows', () => {
  test('audio within one Whisper window is aligned in a single pass', () => {
    expect(planAlignmentWindows(WINDOW)).toEqual([{ start: 0, end: WINDOW }]);
    expect(planAlignmentWindows(12 * SAMPLE_RATE)).toEqual([{ start: 0, end: 12 * SAMPLE_RATE }]);
  });

  test('long audio is covered by contiguous windows that each fit the model', () => {
    const total = 95 * SAMPLE_RATE;
    const windows = planAlignmentWindows(total);
    expect(windows[0]!.start).toBe(0);
    expect(windows.at(-1)!.end).toBe(total);
    for (let i = 0; i < windows.length; i += 1) {
      expect(windows[i]!.end - windows[i]!.start).toBeLessThanOrEqual(WINDOW);
      if (i > 0) expect(windows[i]!.start).toBe(windows[i - 1]!.end);
    }
  });

  test('a window boundary falls in the quietest gap near the window limit', () => {
    const total = 40 * SAMPLE_RATE;
    const samples = new Float32Array(total).fill(0.5);
    const gapStart = 28 * SAMPLE_RATE;
    samples.fill(0, gapStart, gapStart + SAMPLE_RATE / 10);
    const [first] = planAlignmentWindows(total, samples);
    expect(first!.end).toBeGreaterThanOrEqual(gapStart);
    expect(first!.end).toBeLessThanOrEqual(gapStart + SAMPLE_RATE / 10);
  });

  test('a long segment decodes past the old fixed cap', () => {
    const text = 'word '.repeat(120).trim();
    expect(computeAdaptiveDecodeStepLimit(444, text)).toBeGreaterThan(128);
    expect(computeAdaptiveDecodeStepLimit(444, text, 0.5)).toBeLessThan(computeAdaptiveDecodeStepLimit(444, text));
  });
});

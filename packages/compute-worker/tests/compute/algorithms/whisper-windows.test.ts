import { describe, expect, test } from 'vitest';
import {
  computeAdaptiveDecodeStepLimit,
  findAlignmentResumeSample,
  findSpeechEndSample,
  planAlignmentWindows,
} from '../../../src/inference/whisper/align';

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
    // A dense window in a long segment keeps at least the former fixed cap.
    expect(computeAdaptiveDecodeStepLimit(444, text, 0.1)).toBeGreaterThanOrEqual(128);
    expect(computeAdaptiveDecodeStepLimit(444, text, 0.5)).toBeLessThan(computeAdaptiveDecodeStepLimit(444, text));
  });
});

describe('whisper alignment continuation', () => {
  const speech = (seconds: number, speechUntilSec: number) => {
    const samples = new Float32Array(seconds * SAMPLE_RATE);
    samples.fill(0.3, 0, speechUntilSec * SAMPLE_RATE);
    return samples;
  };

  test('resumes after an early end-of-text when speech remains in the window', () => {
    const samples = speech(27, 26.8);
    const window = { start: 0, end: samples.length };
    expect(findAlignmentResumeSample(window, 20.96, samples)).toBe(Math.round(20.96 * SAMPLE_RATE));
  });

  test('does not resume over trailing silence, a short tail, or no progress', () => {
    const samples = speech(27, 21);
    const window = { start: 0, end: samples.length };
    expect(findAlignmentResumeSample(window, 21.2, samples)).toBeNull();
    expect(findAlignmentResumeSample(window, 26.5, speech(27, 27))).toBeNull();
    expect(findAlignmentResumeSample(window, null, samples)).toBeNull();
    expect(findAlignmentResumeSample(window, 0, samples)).toBeNull();
  });

  test('word timing stops shortly after the voice instead of spanning trailing silence', () => {
    const samples = speech(30, 26.8);
    const end = findSpeechEndSample({ start: 0, end: samples.length }, samples);
    expect(end).toBeGreaterThanOrEqual(26.8 * SAMPLE_RATE);
    expect(end).toBeLessThanOrEqual(27 * SAMPLE_RATE);
    expect(findSpeechEndSample({ start: 0, end: samples.length }, new Float32Array(samples.length)))
      .toBe(samples.length);
  });
});

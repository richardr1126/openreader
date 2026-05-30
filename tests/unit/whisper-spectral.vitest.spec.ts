import { describe, expect, test } from 'vitest';
import { buildGoertzelCoefficients, goertzelPower } from '@openreader/compute-core';

function dftPower(samples: Float32Array, k: number): number {
  const n = samples.length;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i += 1) {
    const angle = (-2 * Math.PI * k * i) / n;
    re += samples[i] * Math.cos(angle);
    im += samples[i] * Math.sin(angle);
  }
  return (re * re) + (im * im);
}

describe('whisper spectral helpers', () => {
  test('goertzel power matches direct DFT for non-power-of-two frame size', () => {
    const frameSize = 400;
    const bins = 201;
    const coeffs = buildGoertzelCoefficients(bins, frameSize);
    const samples = new Float32Array(frameSize);
    for (let i = 0; i < frameSize; i += 1) {
      samples[i] = Math.sin((2 * Math.PI * 37 * i) / frameSize) + (0.2 * Math.cos((2 * Math.PI * 91 * i) / frameSize));
    }

    const testBins = [0, 7, 37, 91, 150, 200];
    for (const k of testBins) {
      const expected = dftPower(samples, k);
      const actual = goertzelPower(samples, coeffs[k]);
      const rel = Math.abs(actual - expected) / Math.max(1, Math.abs(expected));
      expect(rel).toBeLessThan(1e-5);
    }
  });
});

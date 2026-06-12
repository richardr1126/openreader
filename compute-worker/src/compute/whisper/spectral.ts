export function buildGoertzelCoefficients(freqBins: number, fftSize: number): Float64Array {
  const coeffs = new Float64Array(freqBins);
  for (let k = 0; k < freqBins; k += 1) {
    coeffs[k] = 2 * Math.cos((2 * Math.PI * k) / fftSize);
  }
  return coeffs;
}

export function goertzelPower(samples: Float32Array, coeff: number): number {
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s0 = samples[i] + (coeff * s1) - s2;
    s2 = s1;
    s1 = s0;
  }

  const power = (s1 * s1) + (s2 * s2) - (coeff * s1 * s2);
  if (!Number.isFinite(power) || power < 0) return 0;
  return power;
}

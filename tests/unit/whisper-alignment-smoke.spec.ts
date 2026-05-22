import { test, expect } from '@playwright/test';
import { readFile } from 'fs/promises';
import path from 'path';
import { alignAudioWithText } from '../../compute/core/src/whisper/alignment';

test.describe('whisper alignment smoke', () => {
  test('runs ONNX alignment end-to-end without decoder reshape errors', async () => {
    test.setTimeout(180000);

    const audioPath = path.join(process.cwd(), 'tests/files/sample.mp3');
    const audioBytes = await readFile(audioPath);
    const buffer = audioBytes.buffer.slice(audioBytes.byteOffset, audioBytes.byteOffset + audioBytes.byteLength);

    const alignments = await alignAudioWithText(
      buffer,
      'This is a sample sentence used to validate whisper alignment execution.',
      undefined,
      { lang: 'en' },
    );

    expect(alignments.length).toBe(1);
    expect(Array.isArray(alignments[0].words)).toBe(true);
    expect(alignments[0].words.length).toBeGreaterThan(0);

    let maxEnd = 0;
    let positiveDurationWordCount = 0;
    for (const word of alignments[0].words) {
      expect(Number.isFinite(word.startSec)).toBe(true);
      expect(Number.isFinite(word.endSec)).toBe(true);
      expect(word.endSec).toBeGreaterThanOrEqual(word.startSec);
      maxEnd = Math.max(maxEnd, word.endSec);
      if (word.endSec > word.startSec) positiveDurationWordCount += 1;
    }
    expect(maxEnd).toBeLessThanOrEqual(10.2);
    expect(positiveDurationWordCount).toBeGreaterThan(0);
  });
});

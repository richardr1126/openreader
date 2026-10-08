import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import ffmpeg from 'ffmpeg-static';
import { getCbrSilenceSecond } from '@openreader/tts/audio-format';
import { runFfmpegExport } from '../../src/jobs/playback/ffmpeg-export';

test.each(['mp3', 'm4b'] as const)('creates a decodable speed-adjusted %s using files', async (format) => {
  const workDir = await mkdtemp(join(tmpdir(), 'openreader-export-test-'));
  try {
    const inputPath = join(workDir, 'input.mp3');
    const outputPath = join(workDir, `output.${format}`);
    await writeFile(inputPath, await getCbrSilenceSecond());
    await runFfmpegExport({ inputPath, outputPath, workDir, format, speed: 1.5,
      title: 'Audiobook test', chapters: [{ title: 'Chapter 1', startMs: 0, endMs: 667 }] });
    expect((await stat(outputPath)).size).toBeGreaterThan(100);
    const decoded = spawnSync(ffmpeg!, ['-v', 'error', '-i', outputPath, '-f', 'null', '-'], { encoding: 'utf8' });
    expect(decoded.status, decoded.stderr).toBe(0);
    expect(decoded.stderr).toBe('');
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}, 15_000);

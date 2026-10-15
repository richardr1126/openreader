import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ModelDownloadProgress } from '../../src/inference/model-download';
import {
  blendVoices,
  chunkTokens,
  encodePhonemes,
  encodeWav,
  KOKORO_MAX_PHONEMES,
  parseVoiceBlend,
} from '../../src/inference/kokoro/engine';
import {
  ensureKokoroAssetFiles,
  KOKORO_COMPONENTS,
  KOKORO_LETTER_TO_SOUND_PATH,
  kokoroAssetStatus,
  removeKokoroAssetFiles,
} from '../../src/inference/kokoro/model-files';
import { createToken } from '../../src/inference/kokoro/misaki/token';

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('local Kokoro voices', () => {
  test('reads Kokoro-FastAPI blend syntax and normalizes the weights', () => {
    expect(parseVoiceBlend('af_heart')).toEqual([{ voice: 'af_heart', weight: 1 }]);
    expect(parseVoiceBlend('af_heart+bf_emma')).toEqual([
      { voice: 'af_heart', weight: 0.5 },
      { voice: 'bf_emma', weight: 0.5 },
    ]);
    const weighted = parseVoiceBlend('af_heart(3) + am_adam(1)');
    expect(weighted.map((entry) => entry.weight)).toEqual([0.75, 0.25]);
  });

  test('refuses voices it has not downloaded', () => {
    expect(() => parseVoiceBlend('jf_alpha')).toThrow(/no English voice/);
    expect(() => parseVoiceBlend('alloy')).toThrow(/cannot read/);
    expect(() => parseVoiceBlend('')).toThrow(/needs a voice/);
    expect(() => parseVoiceBlend('af_heart(0)')).toThrow(/more than zero/);
  });

  test('blends voice packs row by row', () => {
    const size = 510 * 256;
    const a = new Float32Array(size).fill(1);
    const b = new Float32Array(size).fill(3);
    const blended = blendVoices([a, b], [0.25, 0.75]);
    expect(blended.length).toBe(size);
    expect(blended[0]).toBeCloseTo(2.5);
    expect(blended[size - 1]).toBeCloseTo(2.5);
  });
});

describe('local Kokoro encoding', () => {
  test('pads phoneme ids at both ends and drops symbols outside the vocabulary', () => {
    expect(Array.from(encodePhonemes('hˈi'), Number)).toEqual([0, 50, 156, 51, 0]);
    expect(Array.from(encodePhonemes('h❓i'), Number)).toEqual([0, 50, 51, 0]);
  });

  test('writes 16-bit mono WAV and clips out-of-range samples', () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2]), 24_000);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(40)).toBe(8);
    expect([0, 1, 2, 3].map((index) => wav.readInt16LE(44 + index * 2))).toEqual([0, 32767, -32768, 32767]);
  });

  test('splits long text at the last sentence break that fits the model', () => {
    const word = 'ˈæbəkəs';
    const tokens = [];
    for (let sentence = 0; sentence < 20; sentence += 1) {
      for (let index = 0; index < 8; index += 1) {
        tokens.push(createToken({ text: 'abacus', tag: 'NN', whitespace: index === 7 ? '' : ' ', phonemes: word }));
      }
      tokens.push(createToken({ text: '.', tag: '.', whitespace: ' ', phonemes: '.' }));
    }
    const chunks = chunkTokens(tokens);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Array.from(chunk.phonemes).length).toBeLessThanOrEqual(KOKORO_MAX_PHONEMES);
      expect(chunk.phonemes.endsWith('.')).toBe(true);
    }
    expect(chunks.map((chunk) => chunk.text).join(' ')).toBe(
      Array.from({ length: 20 }, () => `${Array(8).fill('abacus').join(' ')}.`).join(' '),
    );
  });
});

describe('local Kokoro model files', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const file = (name: string, body: string, url = `https://models.example/${name}`) => ({
    path: name,
    url,
    size: Buffer.byteLength(body),
    sha256: sha(body),
  });

  async function modelDir() {
    const dir = await mkdtemp(path.join(tmpdir(), 'openreader-kokoro-'));
    cleanupDirs.push(dir);
    return dir;
  }

  test('pins every download to a size and checksum', () => {
    for (const component of KOKORO_COMPONENTS) {
      for (const entry of component.files) {
        expect(entry.size, entry.path).toBeGreaterThan(0);
        expect(entry.sha256, entry.path).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(KOKORO_COMPONENTS.find((component) => component.name === 'Voice pack')?.files).toHaveLength(28);
  });

  test('reports each component through download, verification and ready, then starts warm in silence', async () => {
    const dir = await modelDir();
    const bodies: Record<string, string> = { 'weights.onnx': 'weights', 'voices/af_heart.bin': 'voice' };
    const components = [
      { name: 'Model weights' as const, files: [file('weights.onnx', bodies['weights.onnx']!)] },
      { name: 'Voice pack' as const, files: [file('voices/af_heart.bin', bodies['voices/af_heart.bin']!)] },
    ];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => new Response(
      bodies[String(input).replace('https://models.example/', '')]!,
    ));
    const progress: ModelDownloadProgress[] = [];

    await ensureKokoroAssetFiles({ modelDir: dir, components, fetchImpl, onProgress: (p) => { progress.push(p); } });

    expect(await readFile(path.join(dir, 'voices/af_heart.bin'), 'utf8')).toBe('voice');
    const weightStates = progress.map((p) => p.components?.[0]?.state);
    expect(weightStates[0]).toBe('pending');
    expect(weightStates).toContain('downloading');
    expect(weightStates.indexOf('verifying')).toBeGreaterThan(weightStates.indexOf('downloading'));
    const last = progress.at(-1)!;
    expect(last.components?.map((component) => component.state)).toEqual(['ready', 'ready']);
    expect(last.downloadedBytes).toBe(last.totalBytes);
    expect(last.components?.map((component) => component.name)).toEqual(['Model weights', 'Voice pack']);

    const warm = vi.fn();
    await ensureKokoroAssetFiles({ modelDir: dir, components, fetchImpl, onProgress: warm });
    expect(warm).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('rejects a corrupted download and marks its component failed', async () => {
    const dir = await modelDir();
    const components = [{ name: 'Model weights' as const, files: [file('weights.onnx', 'expected')] }];
    const progress: ModelDownloadProgress[] = [];

    await expect(ensureKokoroAssetFiles({
      modelDir: dir,
      components,
      fetchImpl: async () => new Response('tampered'),
      onProgress: (p) => { progress.push(p); },
    })).rejects.toThrow(/failed verification/);

    expect(progress.at(-1)?.components?.[0]?.state).toBe('failed');
    await expect(stat(path.join(dir, 'weights.onnx'))).rejects.toThrow();
    await expect(stat(path.join(dir, 'weights.onnx.tmp'))).rejects.toThrow();
  });

  test('stops a cancelled download and leaves no partial file', async () => {
    const dir = await modelDir();
    const components = [{ name: 'Model weights' as const, files: [file('weights.onnx', 'x'.repeat(200_000))] }];
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      pull(stream) {
        if (init?.signal?.aborted) return;
        stream.enqueue(new Uint8Array(65_536));
        controller.abort();
      },
    })));

    await expect(ensureKokoroAssetFiles({ modelDir: dir, components, fetchImpl, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(stat(path.join(dir, 'weights.onnx.tmp'))).rejects.toThrow();
    await expect(stat(path.join(dir, 'weights.onnx'))).rejects.toThrow();
  });

  test('reports installed sizes and removes the model folder', async () => {
    const dir = await modelDir();
    const before = await kokoroAssetStatus(dir);
    expect(before.map((component) => component.installedBytes)).toEqual([0, 0, 0]);
    expect(before.every((component) => component.totalBytes > 0)).toBe(true);

    await removeKokoroAssetFiles(dir);
    await expect(stat(dir)).rejects.toThrow();
  });

  test('ships the letter-to-sound rules with the worker', async () => {
    const rules = await readFile(KOKORO_LETTER_TO_SOUND_PATH);
    expect(createHash('sha256').update(rules).digest('hex')).toBe(
      '14e0911c6c92ea134c5ae830f89b69038ab9dbca5662896d012394f30309fbf2',
    );
    const downloaded = KOKORO_COMPONENTS.flatMap((component) => component.files.map((entry) => entry.path));
    expect(downloaded.some((entry) => entry.includes('letter_to_sound'))).toBe(false);
  });
});

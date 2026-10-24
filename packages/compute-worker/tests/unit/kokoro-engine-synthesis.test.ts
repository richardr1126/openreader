import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

// The real model is 325 MB; these tests run the engine against a stand-in
// ONNX session and the recorded Misaki subset so they stay fast and offline.
const fake = vi.hoisted(() => ({
  modelDir: '',
  active: 0,
  maxActive: 0,
  runs: [] as Array<{ ids: number[]; style: Float32Array; speed: number }>,
  onRun: null as null | (() => Promise<void>),
}));

vi.mock('onnxruntime-node', () => {
  class Tensor {
    constructor(public type: string, public data: unknown, public dims: number[]) {}
  }
  const session = {
    async run(feeds: Record<string, Tensor>) {
      fake.active += 1;
      fake.maxActive = Math.max(fake.maxActive, fake.active);
      try {
        fake.runs.push({
          ids: Array.from(feeds.input_ids!.data as BigInt64Array, Number),
          style: feeds.style!.data as Float32Array,
          speed: (feeds.speed!.data as Float32Array)[0]!,
        });
        await fake.onRun?.();
        // Two frames for every token, and the audio those frames make.
        const tokens = (feeds.input_ids!.data as BigInt64Array).length;
        return {
          waveform: { data: new Float32Array(tokens * 2 * 600).fill(0.5) },
          duration: { data: new BigInt64Array(tokens).fill(BigInt(2)) },
        };
      } finally {
        fake.active -= 1;
      }
    },
  };
  return { Tensor, InferenceSession: { create: vi.fn(async () => session) } };
});

vi.mock('../../src/inference/kokoro/model-files', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/inference/kokoro/model-files')>();
  return {
    ...original,
    ensureKokoroAssets: vi.fn(async () => undefined),
    kokoroAssetPath: (relative: string) => path.join(fake.modelDir, relative),
  };
});

const { synthesizeKokoro } = await import('../../src/inference/kokoro/engine');

const STYLE_DIM = 256;
const fixtureDir = path.resolve(process.cwd(), 'packages/compute-worker/tests/fixtures/kokoro-g2p');

fake.modelDir = mkdtempSync(path.join(tmpdir(), 'openreader-kokoro-engine-'));
mkdirSync(path.join(fake.modelDir, 'misaki'));
mkdirSync(path.join(fake.modelDir, 'voices'));
mkdirSync(path.join(fake.modelDir, 'g2p'));
writeFileSync(path.join(fake.modelDir, 'g2p', 'hi.tsv'), [
  'maxw\t1', 'scalars\t1', 'vowels\ta ə',
  'w\tनमस्ते\tnəmˈʌsteː', 'w\tदुनिया\tdˈʊnɪjˌaː', 'n\t123\tˈeːksˈɔː tˈeːis',
].join('\n'));
for (const name of ['us_gold.json', 'us_silver.json']) {
  copyFileSync(path.join(fixtureDir, name), path.join(fake.modelDir, 'misaki', name));
}
copyFileSync(path.join(fixtureDir, 'letter_to_sound.tsv'), path.join(fake.modelDir, 'g2p', 'en-us.tsv'));
// Every value in row r is r, so a run's style vector names the row it used.
const pack = new Float32Array(510 * STYLE_DIM);
for (let row = 0; row < 510; row += 1) pack.fill(row, row * STYLE_DIM, (row + 1) * STYLE_DIM);
writeFileSync(path.join(fake.modelDir, 'voices', 'af_heart.bin'), Buffer.from(pack.buffer));
writeFileSync(path.join(fake.modelDir, 'voices', 'hf_alpha.bin'), Buffer.from(pack.buffer));

afterAll(() => rmSync(fake.modelDir, { recursive: true, force: true }));

beforeEach(() => {
  fake.runs = [];
  fake.active = 0;
  fake.maxActive = 0;
  fake.onRun = null;
});

const longText = Array.from({ length: 40 }, () => 'The cat sat on the mat.').join(' ');

describe('local Kokoro synthesis', () => {
  test('uses Hindi data and preserves native words in the model timings', async () => {
    const { words, wav } = await synthesizeKokoro({ text: 'नमस्ते दुनिया १२३।', voice: 'hf_alpha', speed: 1 });
    expect(words.map((word) => word.word)).toEqual(['नमस्ते', 'दुनिया', '१२३।']);
    expect(words.every((word) => word.end > word.start)).toBe(true);
    expect(words.at(-1)!.end).toBeLessThanOrEqual((wav.length - 44) / 2 / 24000);
    const { ensureKokoroAssets } = await import('../../src/inference/kokoro/model-files');
    expect(ensureKokoroAssets).toHaveBeenCalledWith(undefined, { voices: ['hf_alpha'], language: 'hi' });
  });
  test('runs the model once per chunk with the voice row for its length and returns WAV', async () => {
    const { wav } = await synthesizeKokoro({ text: 'The cat sat on the mat.', voice: 'af_heart', speed: 1.25 });

    expect(fake.runs).toHaveLength(1);
    const [run] = fake.runs;
    expect(run!.ids[0]).toBe(0);
    expect(run!.ids.at(-1)).toBe(0);
    const phonemeCount = run!.ids.length - 2;
    expect(run!.style).toHaveLength(STYLE_DIM);
    expect(run!.style[0]).toBe(phonemeCount - 1);
    expect(run!.speed).toBe(1.25);

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(40)).toBe(run!.ids.length * 2 * 600 * 2);
  });

  test('times each word from the frames of its own phonemes', async () => {
    const { words } = await synthesizeKokoro({ text: 'The cat sat on the mat.', voice: 'af_heart', speed: 1 });

    const frame = 600 / 24_000;
    const [run] = fake.runs;
    const phonemeCount = run!.ids.length - 2;
    expect(words.map((word) => word.word)).toEqual(['The', 'cat', 'sat', 'on', 'the', 'mat.']);
    // The leading pad token's two frames come before the first phoneme.
    expect(words[0]!.start).toBeCloseTo(2 * frame);
    // "mat." ends where its full stop, the last phoneme, begins.
    expect(words.at(-1)!.end).toBeCloseTo(2 * phonemeCount * frame);
    for (const [index, word] of words.entries()) {
      expect(word.end).toBeGreaterThan(word.start);
      // The space between two words belongs to neither.
      if (index > 0) expect(word.start).toBeCloseTo(words[index - 1]!.end + 2 * frame);
    }
  });

  test('splits long text into several runs, concatenated in order', async () => {
    const { wav, words } = await synthesizeKokoro({ text: longText, voice: 'af_heart', speed: 1 });

    expect(fake.runs.length).toBeGreaterThan(1);
    for (const run of fake.runs) expect(run.ids.length - 2).toBeLessThanOrEqual(510);
    const samples = fake.runs.reduce((sum, run) => sum + run.ids.length * 2 * 600, 0);
    expect(wav.readUInt32LE(40)).toBe(samples * 2);
    // Every word is timed, and a later run's words start after an earlier run's audio.
    expect(words).toHaveLength(40 * 6);
    for (let index = 1; index < words.length; index += 1) {
      expect(words[index]!.start).toBeGreaterThan(words[index - 1]!.end);
    }
    expect(words.at(-1)!.end).toBeLessThan(samples / 24_000);
  });

  test('stops at the next chunk once cancelled', async () => {
    const controller = new AbortController();
    fake.onRun = async () => {
      controller.abort();
    };

    await expect(
      synthesizeKokoro({ text: longText, voice: 'af_heart', speed: 1 }, controller.signal),
    ).rejects.toThrow();
    expect(fake.runs).toHaveLength(1);
  });

  test('custom source-word splits add PCM silence and move later word timings by every join', async () => {
    const text = Array.from({ length: 8 }, () => 'The cat sat on the mat.').join(' ');
    const customization = { pieceCharacterLimit: 50, piecePauseMilliseconds: 150, blockPauseMilliseconds: 500 };
    const { wav, words } = await synthesizeKokoro({ text, voice: 'af_heart', speed: 1, customization });
    expect(fake.runs.length).toBeGreaterThan(1);
    expect(words.map(word => word.word)).toEqual(text.split(' '));
    const runSamples = fake.runs.map(run => run.ids.length * 2 * 600);
    const expectedSamples = runSamples.reduce((sum, count) => sum + count, 0) + (runSamples.length - 1) * 3600 + 12000;
    expect(wav.readUInt32LE(40)).toBe(expectedSamples * 2);
    const firstEnd = runSamples[0]!;
    expect(wav.subarray(44 + firstEnd * 2, 44 + (firstEnd + 3600) * 2).every(byte => byte === 0)).toBe(true);
    expect(wav.subarray(-24000).every(byte => byte === 0)).toBe(true);
    const secondStart = words.find(word => word.start >= firstEnd / 24000)!;
    expect(secondStart.start).toBeCloseTo((firstEnd + 3600 + 1200) / 24000);
    expect(words.at(-1)!.end).toBeLessThan((expectedSamples - 12000) / 24000);
  });

  test('explicit zero keeps the exact default waveform and timings', async () => {
    const request = { text: longText, voice: 'af_heart', speed: 1 };
    const baseline = await synthesizeKokoro(request);
    const zero = await synthesizeKokoro({ ...request, customization: { pieceCharacterLimit: null, piecePauseMilliseconds: 0, blockPauseMilliseconds: 0 } });
    expect(zero.wav.equals(baseline.wav)).toBe(true);
    expect(zero.words).toEqual(baseline.words);
  });

  test('cancels customized piece generation before scheduling the next run', async () => {
    const controller = new AbortController();
    fake.onRun = async () => { controller.abort(); };
    await expect(synthesizeKokoro({ text: longText, voice: 'af_heart', speed: 1,
      customization: { pieceCharacterLimit: 50, piecePauseMilliseconds: 2000, blockPauseMilliseconds: 2000 } }, controller.signal)).rejects.toThrow();
    expect(fake.runs).toHaveLength(1);
  });

  test('never runs two model passes at once', async () => {
    fake.onRun = () => new Promise((resolve) => setTimeout(resolve, 5));

    await Promise.all([
      synthesizeKokoro({ text: longText, voice: 'af_heart', speed: 1 }),
      synthesizeKokoro({ text: longText, voice: 'af_heart', speed: 1 }),
    ]);

    expect(fake.runs.length).toBeGreaterThan(2);
    expect(fake.maxActive).toBe(1);
  });

  test('turns text with nothing to say into a short valid clip without running the model', async () => {
    const { wav, words } = await synthesizeKokoro({ text: '   ', voice: 'af_heart', speed: 1 });

    expect(fake.runs).toHaveLength(0);
    expect(wav.readUInt32LE(40)).toBe(2_400 * 2);
    expect(words).toEqual([]);
  });
});

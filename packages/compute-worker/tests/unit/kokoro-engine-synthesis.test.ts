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
  runs: [] as Array<{ ids: bigint[]; style: Float32Array; speed: number }>,
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
          ids: [...(feeds.input_ids!.data as BigInt64Array)],
          style: feeds.style!.data as Float32Array,
          speed: (feeds.speed!.data as Float32Array)[0]!,
        });
        await fake.onRun?.();
        return { waveform: { data: new Float32Array(100).fill(0.5) } };
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
for (const name of ['us_gold.json', 'us_silver.json']) {
  copyFileSync(path.join(fixtureDir, name), path.join(fake.modelDir, 'misaki', name));
}
// Every value in row r is r, so a run's style vector names the row it used.
const pack = new Float32Array(510 * STYLE_DIM);
for (let row = 0; row < 510; row += 1) pack.fill(row, row * STYLE_DIM, (row + 1) * STYLE_DIM);
writeFileSync(path.join(fake.modelDir, 'voices', 'af_heart.bin'), Buffer.from(pack.buffer));

afterAll(() => rmSync(fake.modelDir, { recursive: true, force: true }));

beforeEach(() => {
  fake.runs = [];
  fake.active = 0;
  fake.maxActive = 0;
  fake.onRun = null;
});

const longText = Array.from({ length: 40 }, () => 'The cat sat on the mat.').join(' ');

describe('local Kokoro synthesis', () => {
  test('runs the model once per chunk with the voice row for its length and returns WAV', async () => {
    const wav = await synthesizeKokoro({ text: 'The cat sat on the mat.', voice: 'af_heart', speed: 1.25 });

    expect(fake.runs).toHaveLength(1);
    const [run] = fake.runs;
    expect(run!.ids[0]).toBe(0n);
    expect(run!.ids.at(-1)).toBe(0n);
    const phonemeCount = run!.ids.length - 2;
    expect(run!.style).toHaveLength(STYLE_DIM);
    expect(run!.style[0]).toBe(phonemeCount - 1);
    expect(run!.speed).toBe(1.25);

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(40)).toBe(100 * 2);
  });

  test('splits long text into several runs, concatenated in order', async () => {
    const wav = await synthesizeKokoro({ text: longText, voice: 'af_heart', speed: 1 });

    expect(fake.runs.length).toBeGreaterThan(1);
    for (const run of fake.runs) expect(run.ids.length - 2).toBeLessThanOrEqual(510);
    expect(wav.readUInt32LE(40)).toBe(fake.runs.length * 100 * 2);
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
    const wav = await synthesizeKokoro({ text: '   ', voice: 'af_heart', speed: 1 });

    expect(fake.runs).toHaveLength(0);
    expect(wav.readUInt32LE(40)).toBe(2_400 * 2);
  });
});

/**
 * Kokoro-82M on onnxruntime-node, in the worker process.
 *
 * Text goes through the Misaki port (no espeak, no GPL phonemizer), is split
 * into model-sized chunks exactly as Kokoro's own `KPipeline` splits it, and
 * each chunk is one ONNX run. Runs are serialized through one queue: the
 * model already uses every thread the worker gives ONNX, so running two at
 * once only makes both slower. onnxruntime cannot interrupt a run in
 * progress, so cancellation is checked before every chunk; a superseded
 * request stops at the next chunk boundary rather than finishing the segment.
 */

import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-node';
import { getOnnxThreadsPerJob } from '../../infrastructure/config';
import type { ModelDownloadProgressHandler } from '../model-download';
import {
  ensureKokoroAssets,
  KOKORO_MODEL_FILE,
  KOKORO_SAMPLE_RATE,
  KOKORO_VOICE_SHA256,
  kokoroAssetPath,
} from './model-files';
import { G2P } from './misaki/g2p';
import { LetterToSound } from './misaki/letter-to-sound';
import { Lexicon } from './misaki/lexicon';
import type { MToken } from './misaki/token';

/** Kokoro's phoneme vocabulary (hexgrad/Kokoro-82M config.json). */
const VOCAB: Record<string, number> = {
  ';': 1, ':': 2, ',': 3, '.': 4, '!': 5, '?': 6, '—': 9, '…': 10, '"': 11, '(': 12, ')': 13, '“': 14, '”': 15,
  ' ': 16, '̃': 17, 'ʣ': 18, 'ʥ': 19, 'ʦ': 20, 'ʨ': 21, 'ᵝ': 22, 'ꭧ': 23, A: 24, I: 25, O: 31, Q: 33, S: 35,
  T: 36, W: 39, Y: 41, 'ᵊ': 42, a: 43, b: 44, c: 45, d: 46, e: 47, f: 48, h: 50, i: 51, j: 52, k: 53, l: 54, m: 55,
  n: 56, o: 57, p: 58, q: 59, r: 60, s: 61, t: 62, u: 63, v: 64, w: 65, x: 66, y: 67, z: 68, 'ɑ': 69, 'ɐ': 70,
  'ɒ': 71, 'æ': 72, 'β': 75, 'ɔ': 76, 'ɕ': 77, 'ç': 78, 'ɖ': 80, 'ð': 81, 'ʤ': 82, 'ə': 83, 'ɚ': 85, 'ɛ': 86,
  'ɜ': 87, 'ɟ': 90, 'ɡ': 92, 'ɥ': 99, 'ɨ': 101, 'ɪ': 102, 'ʝ': 103, 'ɯ': 110, 'ɰ': 111, 'ŋ': 112, 'ɳ': 113,
  'ɲ': 114, 'ɴ': 115, 'ø': 116, 'ɸ': 118, 'θ': 119, 'œ': 120, 'ɹ': 123, 'ɾ': 125, 'ɻ': 126, 'ʁ': 128, 'ɽ': 129,
  'ʂ': 130, 'ʃ': 131, 'ʈ': 132, 'ʧ': 133, 'ʊ': 135, 'ʋ': 136, 'ʌ': 138, 'ɣ': 139, 'ɤ': 140, 'χ': 142, 'ʎ': 143,
  'ʒ': 147, 'ʔ': 148, 'ˈ': 156, 'ˌ': 157, 'ː': 158, 'ʰ': 162, 'ʲ': 164, '↓': 169, '→': 171, '↗': 172, '↘': 173,
  'ᵻ': 177,
};

/** The model's context is 512 ids: 510 phonemes between two pad tokens. */
export const KOKORO_MAX_PHONEMES = 510;
const STYLE_DIM = 256;
const VOICE_ROWS = 510;
const WATERFALL = ['!.?…', ':;', ',—'];
const BUMPS = new Set([')', '”']);

const length = (text: string) => Array.from(text).length;

export interface PhonemeChunk {
  text: string;
  phonemes: string;
}

function tokensToPhonemes(tokens: MToken[]): string {
  return tokens.map((token) => (token.phonemes ?? '') + (token.whitespace ? ' ' : '')).join('').trim();
}

function tokensToText(tokens: MToken[]): string {
  return tokens.map((token) => token.text + (token.whitespace ? ' ' : '')).join('').trim();
}

/** `KPipeline.waterfall_last`: the latest sentence-ish break that fits. */
function waterfallLast(tokens: MToken[], nextCount: number): number {
  for (const classes of WATERFALL) {
    let split = -1;
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      const phonemes = tokens[index]!.phonemes ?? '';
      if (length(phonemes) === 1 && classes.includes(phonemes)) {
        split = index;
        break;
      }
    }
    if (split < 0) continue;
    let end = split + 1;
    if (end < tokens.length && BUMPS.has(tokens[end]!.phonemes ?? '')) end += 1;
    if (nextCount - length(tokensToPhonemes(tokens.slice(0, end))) <= KOKORO_MAX_PHONEMES) return end;
  }
  return tokens.length;
}

/** `KPipeline.en_tokenize`: model-sized chunks, split at the best break. */
export function chunkTokens(tokens: MToken[]): PhonemeChunk[] {
  const chunks: PhonemeChunk[] = [];
  let pending: MToken[] = [];
  let count = 0;
  for (const token of tokens) {
    let next = (token.phonemes ?? '') + (token.whitespace ? ' ' : '');
    const nextCount = count + length(next.trimEnd());
    if (nextCount > KOKORO_MAX_PHONEMES) {
      const split = waterfallLast(pending, nextCount);
      const head = pending.slice(0, split);
      const phonemes = tokensToPhonemes(head);
      if (phonemes) chunks.push({ text: tokensToText(head), phonemes });
      pending = pending.slice(split);
      count = length(tokensToPhonemes(pending));
      if (pending.length === 0) next = next.trimStart();
    }
    pending.push(token);
    count += length(next);
  }
  const phonemes = tokensToPhonemes(pending);
  if (phonemes) chunks.push({ text: tokensToText(pending), phonemes });
  return chunks;
}

export function encodePhonemes(phonemes: string): BigInt64Array {
  const ids = Array.from(phonemes)
    .slice(0, KOKORO_MAX_PHONEMES)
    .map((phoneme) => VOCAB[phoneme])
    .filter((id): id is number => id !== undefined);
  const encoded = new BigInt64Array(ids.length + 2);
  ids.forEach((id, index) => {
    encoded[index + 1] = BigInt(id);
  });
  return encoded;
}

export interface VoiceWeight {
  voice: string;
  weight: number;
}

/**
 * Kokoro-FastAPI's blend syntax: `af_heart`, `af_heart+bf_emma`, or with
 * weights, `af_heart(0.7)+bf_emma(0.3)`. Weights are normalized.
 */
export function parseVoiceBlend(spec: string): VoiceWeight[] {
  const parts = spec.split('+').map((part) => part.trim()).filter(Boolean);
  const voices = parts.map((part) => {
    const match = /^([a-z]{2}_[a-z0-9]+)(?:\(\s*([0-9]*\.?[0-9]+)\s*\))?$/i.exec(part);
    if (!match) throw new Error(`Local Kokoro cannot read the voice "${part}"`);
    const voice = match[1]!.toLowerCase();
    if (!Object.hasOwn(KOKORO_VOICE_SHA256, voice)) throw new Error(`Local Kokoro has no English voice "${voice}"`);
    return { voice, weight: match[2] === undefined ? 1 : Number(match[2]) };
  });
  if (voices.length === 0) throw new Error('Local Kokoro needs a voice');
  const total = voices.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) throw new Error('Local Kokoro voice weights must add up to more than zero');
  return voices.map((entry) => ({ voice: entry.voice, weight: entry.weight / total }));
}

export function blendVoices(packs: Float32Array[], weights: number[]): Float32Array {
  const blended = new Float32Array(VOICE_ROWS * STYLE_DIM);
  packs.forEach((pack, index) => {
    const weight = weights[index]!;
    for (let offset = 0; offset < blended.length; offset += 1) blended[offset] += pack[offset]! * weight;
  });
  return blended;
}

export function encodeWav(samples: Float32Array, sampleRate = KOKORO_SAMPLE_RATE): Buffer {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + samples.length * 2, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    wav.writeInt16LE(Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), 44 + index * 2);
  }
  return wav;
}

interface KokoroRuntime {
  session: ort.InferenceSession;
  g2p(british: boolean): Promise<G2P>;
  voice(name: string): Promise<Float32Array>;
}

let runtime: Promise<KokoroRuntime> | null = null;

async function loadRuntime(modelDir?: string): Promise<KokoroRuntime> {
  const at = (relative: string) => kokoroAssetPath(relative, modelDir);
  const session = await ort.InferenceSession.create(at(KOKORO_MODEL_FILE), {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
    intraOpNumThreads: getOnnxThreadsPerJob(),
    interOpNumThreads: 1,
    executionMode: 'sequential',
  });

  let letterToSound: Promise<LetterToSound> | null = null;
  const dialects = new Map<boolean, Promise<G2P>>();
  const voices = new Map<string, Promise<Float32Array>>();

  return {
    session,
    g2p(british) {
      let pending = dialects.get(british);
      if (!pending) {
        letterToSound ??= readFile(at('misaki/letter_to_sound.tsv'), 'utf8').then((tsv) => new LetterToSound(tsv));
        const dialect = british ? 'gb' : 'us';
        pending = Promise.all([
          readFile(at(`misaki/${dialect}_gold.json`), 'utf8'),
          readFile(at(`misaki/${dialect}_silver.json`), 'utf8'),
          letterToSound,
        ]).then(([gold, silver, lts]) => new G2P({
          lexicon: new Lexicon({ british, data: { gold: JSON.parse(gold), silver: JSON.parse(silver) }, letterToSound: lts }),
          // Kokoro's own pipeline drops unknown words rather than reading a marker.
          unk: '',
        }));
        pending.catch(() => dialects.delete(british));
        dialects.set(british, pending);
      }
      return pending;
    },
    voice(name) {
      let pending = voices.get(name);
      if (!pending) {
        pending = readFile(at(`voices/${name}.bin`)).then((bytes) => {
          const copy = new Uint8Array(bytes);
          return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
        });
        pending.catch(() => voices.delete(name));
        voices.set(name, pending);
      }
      return pending;
    },
  };
}

async function getRuntime(onModelDownloadProgress?: ModelDownloadProgressHandler): Promise<KokoroRuntime> {
  await ensureKokoroAssets(onModelDownloadProgress);
  runtime ??= loadRuntime().catch((error: unknown) => {
    runtime = null;
    throw error;
  });
  return runtime;
}

/** Downloads and loads the model ahead of the first segment. */
export async function prepareKokoro(onModelDownloadProgress?: ModelDownloadProgressHandler): Promise<void> {
  await getRuntime(onModelDownloadProgress);
}

let queueTail: Promise<unknown> = Promise.resolve();

/** One ONNX run at a time; a cancelled waiter leaves the queue at once. */
function runExclusive<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const turn = queueTail.then(() => {
    signal?.throwIfAborted();
    return run();
  });
  queueTail = turn.catch(() => undefined);
  if (!signal) return turn;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    turn.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export interface KokoroSynthesisRequest {
  text: string;
  voice: string;
  speed: number;
}

/** 24 kHz mono 16-bit WAV for `text`, or a rejection when `signal` aborts. */
export async function synthesizeKokoro(
  request: KokoroSynthesisRequest,
  signal?: AbortSignal,
  onModelDownloadProgress?: ModelDownloadProgressHandler,
): Promise<Buffer> {
  const blend = parseVoiceBlend(request.voice);
  const kokoro = await getRuntime(onModelDownloadProgress);
  signal?.throwIfAborted();
  const british = blend[0]!.voice.startsWith('b');
  const [g2p, packs] = await Promise.all([
    kokoro.g2p(british),
    Promise.all(blend.map((entry) => kokoro.voice(entry.voice))),
  ]);
  const voicePack = packs.length === 1 ? packs[0]! : blendVoices(packs, blend.map((entry) => entry.weight));
  const speed = Number.isFinite(request.speed) && request.speed > 0 ? request.speed : 1;

  const chunks = chunkTokens(g2p.phonemize(request.text).tokens);
  const audio: Float32Array[] = [];
  for (const chunk of chunks) {
    signal?.throwIfAborted();
    const ids = encodePhonemes(chunk.phonemes);
    if (ids.length <= 2) continue;
    const row = Math.min(VOICE_ROWS - 1, Math.max(0, length(chunk.phonemes) - 1));
    const style = voicePack.slice(row * STYLE_DIM, (row + 1) * STYLE_DIM);
    const output = await runExclusive(() => kokoro.session.run({
      input_ids: new ort.Tensor('int64', ids, [1, ids.length]),
      style: new ort.Tensor('float32', style, [1, STYLE_DIM]),
      speed: new ort.Tensor('float32', new Float32Array([speed]), [1]),
    }), signal);
    audio.push(output.waveform!.data as Float32Array);
  }
  signal?.throwIfAborted();

  // Text with nothing speakable still yields a short, valid clip.
  const sampleCount = audio.reduce((sum, part) => sum + part.length, 0) || Math.round(KOKORO_SAMPLE_RATE / 10);
  const samples = new Float32Array(sampleCount);
  let offset = 0;
  for (const part of audio) {
    samples.set(part, offset);
    offset += part.length;
  }
  return encodeWav(samples);
}

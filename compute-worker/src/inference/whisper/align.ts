import { createHash, randomUUID } from 'crypto';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import * as ort from 'onnxruntime-node';
import { Tokenizer } from '@huggingface/tokenizers';
import JSZip from 'jszip';
import type { TTSAudioBuffer, TTSAudioBytes, TTSSentenceAlignment } from '../types/tts';
import { getFFmpegPath } from '../platform/ffmpeg';
import { getOnnxThreadsPerJob } from '../config/cpu-budget';
import { getComputeTimeoutConfig } from '../config/timeout';
import {
  mapWordsToSentenceOffsets,
  type WhisperWord,
} from './alignment-map';
import { buildGoertzelCoefficients, goertzelPower } from './spectral';
import {
  buildWordsFromTimestampedTokens,
  extractTokenStartTimestamps,
} from './token-timestamps';
import {
  ensureWhisperModel,
  WHISPER_CONFIG_PATH,
  WHISPER_GENERATION_CONFIG_PATH,
  WHISPER_TOKENIZER_CONFIG_PATH,
  WHISPER_TOKENIZER_PATH,
  WHISPER_ENCODER_MODEL_PATH,
  WHISPER_DECODER_MERGED_MODEL_PATH,
  WHISPER_DECODER_WITH_PAST_MODEL_PATH,
} from './model';

interface WhisperAlignmentOptions {
  lang?: string;
  textHint?: string;
}

export interface WhisperRequestBody {
  text: string;
  audio: TTSAudioBytes;
  lang?: string;
}

interface WhisperRuntime {
  encoder: ort.InferenceSession;
  decoderMerged: ort.InferenceSession;
  decoderWithPast: ort.InferenceSession;
  tokenizer: Tokenizer;
  promptStartToken: number;
  defaultLanguageToken: number;
  transcribeToken: number;
  eosTokenId: number;
  noTimestampsTokenId: number;
  timestampBeginTokenId: number;
  maxInitialTimestampIndex: number;
  maxDecodeSteps: number;
  suppressTokens: Set<number>;
  beginSuppressTokens: Set<number>;
  alignmentHeads: Array<[number, number]>;
  prefillFetches: string[];
  stepFetches: string[];
}

type WhisperAlignmentState = {
  alignmentCache: Map<string, TTSSentenceAlignment[]>;
  alignmentInFlight: Map<string, Promise<TTSSentenceAlignment[]>>;
  runtimePromise: Promise<WhisperRuntime> | null;
  pendingAlignments: number;
  officialMelFilters: Float32Array[] | null;
  emptyPastFeedsTemplate: Record<string, ort.Tensor> | null;
};

const WHISPER_ALIGNMENT_STATE_KEY = '__openreaderWhisperAlignmentStateV1';
const g = globalThis as typeof globalThis & Record<string, unknown>;
const state = (() => {
  const existing = g[WHISPER_ALIGNMENT_STATE_KEY] as WhisperAlignmentState | undefined;
  if (existing) return existing;
  const created: WhisperAlignmentState = {
    alignmentCache: new Map<string, TTSSentenceAlignment[]>(),
    alignmentInFlight: new Map<string, Promise<TTSSentenceAlignment[]>>(),
    runtimePromise: null,
    pendingAlignments: 0,
    officialMelFilters: null,
    emptyPastFeedsTemplate: null,
  };
  g[WHISPER_ALIGNMENT_STATE_KEY] = created;
  return created;
})();
const alignmentCache = state.alignmentCache;
const alignmentInFlight = state.alignmentInFlight;
const ALIGNMENT_CACHE_MAX_ENTRIES = 256;
const MAX_DECODE_STEPS_CAP = 128;
const ALIGNMENT_TIMEOUT_BUFFER_MS = 2_000;
const MIN_ALIGNMENT_TIMEOUT_MS = 5_000;
const MIN_FFMPEG_DECODE_TIMEOUT_MS = 10_000;
const MAX_FFMPEG_DECODE_TIMEOUT_MS = 60_000;

const SAMPLE_RATE = 16000;
const N_FFT = 400;
const HOP_LENGTH = 160;
const CHUNK_LENGTH_SECONDS = 30;
const N_SAMPLES = CHUNK_LENGTH_SECONDS * SAMPLE_RATE;
const N_FRAMES = N_SAMPLES / HOP_LENGTH;
const N_MELS = 80;
const WHISPER_NUM_HEADS = 8;
const WHISPER_HEAD_DIM = 64;
const WHISPER_NUM_LAYERS = 6;
const MEL_FILTER_BINS = (N_FFT / 2) + 1;

const hannWindow = buildHannWindow(N_FFT);
const goertzelCoefficients = buildGoertzelCoefficients(MEL_FILTER_BINS, N_FFT);

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MEL_FILTERS_NPZ_PATH = join(MODULE_DIR, 'assets', 'mel_filters.npz');

function buildHannWindow(length: number): Float32Array {
  const window = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
  }
  return window;
}

function parseNpyFloat32(bytes: Uint8Array): { shape: number[]; data: Float32Array } {
  if (bytes.length < 12) {
    throw new Error('Invalid NPY payload: too short');
  }
  const magic = String.fromCharCode(...bytes.slice(0, 6));
  if (magic !== '\u0093NUMPY') {
    throw new Error('Invalid NPY payload: missing magic header');
  }

  const major = bytes[6];
  const headerLength = major <= 1
    ? new DataView(bytes.buffer, bytes.byteOffset + 8, 2).getUint16(0, true)
    : new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0, true);
  const headerOffset = major <= 1 ? 10 : 12;
  const header = Buffer.from(bytes.slice(headerOffset, headerOffset + headerLength)).toString('latin1');

  const descrMatch = header.match(/'descr':\s*'([^']+)'/);
  if (!descrMatch || descrMatch[1] !== '<f4') {
    throw new Error(`Unsupported NPY dtype for mel filter: ${descrMatch?.[1] ?? 'unknown'}`);
  }

  const shapeMatch = header.match(/'shape':\s*\(([^)]+)\)/);
  if (!shapeMatch) {
    throw new Error('NPY payload missing shape metadata');
  }
  const shape = shapeMatch[1]
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => Number(token))
    .filter((n) => Number.isFinite(n) && n > 0);

  const dataOffset = headerOffset + headerLength;
  const dataBytes = bytes.slice(dataOffset);
  const totalFloats = Math.floor(dataBytes.byteLength / 4);
  const data = new Float32Array(totalFloats);
  const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);
  for (let i = 0; i < totalFloats; i += 1) {
    data[i] = view.getFloat32(i * 4, true);
  }

  return { shape, data };
}

async function loadOfficialMelFilters(): Promise<Float32Array[]> {
  if (state.officialMelFilters) return state.officialMelFilters;

  const npzBytes = await readFile(MEL_FILTERS_NPZ_PATH);
  const zip = await JSZip.loadAsync(npzBytes);
  const mel80 = zip.file('mel_80.npy');
  if (!mel80) {
    throw new Error('OpenAI mel filter asset is missing mel_80.npy');
  }

  const raw = await mel80.async('uint8array');
  const parsed = parseNpyFloat32(raw);
  const [rows, cols] = parsed.shape;
  if (rows !== N_MELS || cols !== MEL_FILTER_BINS) {
    throw new Error(`Unexpected mel filter shape: [${rows}, ${cols}]`);
  }

  const filters: Float32Array[] = [];
  for (let row = 0; row < rows; row += 1) {
    const start = row * cols;
    filters.push(parsed.data.slice(start, start + cols));
  }

  state.officialMelFilters = filters;
  return filters;
}

function pcm16ToFloat32(buffer: Buffer): Float32Array {
  const view = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
  const out = new Float32Array(view.length);
  for (let i = 0; i < view.length; i += 1) {
    out[i] = view[i] / 32768;
  }
  return out;
}

function padOrTrimAudio(samples: Float32Array): Float32Array {
  if (samples.length === N_SAMPLES) return samples;
  if (samples.length > N_SAMPLES) return samples.subarray(0, N_SAMPLES);

  const padded = new Float32Array(N_SAMPLES);
  padded.set(samples, 0);
  return padded;
}

function reflectPad(audio: Float32Array, pad: number): Float32Array {
  const out = new Float32Array(audio.length + (2 * pad));
  out.set(audio, pad);

  // Match PyTorch reflect padding (exclude edge sample).
  for (let i = 0; i < pad; i += 1) {
    out[pad - 1 - i] = audio[Math.min(audio.length - 1, i + 1)];
    out[pad + audio.length + i] = audio[Math.max(0, audio.length - 2 - i)];
  }

  return out;
}

function computeLogMelSpectrogram(audioSamples: Float32Array): ort.Tensor {
  if (!state.officialMelFilters) {
    throw new Error('Whisper mel filters not loaded');
  }

  const paddedAudio = reflectPad(audioSamples, N_FFT / 2);
  const stftFrames = N_FRAMES + 1;
  const frameCount = N_FRAMES;
  const freqBins = MEL_FILTER_BINS;

  const melSpec = Array.from({ length: N_MELS }, () => new Float32Array(frameCount));
  const frame = new Float32Array(N_FFT);
  const power = new Float32Array(freqBins);

  for (let frameIndex = 0; frameIndex < stftFrames; frameIndex += 1) {
    const offset = frameIndex * HOP_LENGTH;

    for (let i = 0; i < N_FFT; i += 1) {
      frame[i] = (paddedAudio[offset + i] ?? 0) * hannWindow[i];
    }

    for (let k = 0; k < freqBins; k += 1) {
      power[k] = goertzelPower(frame, goertzelCoefficients[k]);
    }

    if (frameIndex === stftFrames - 1) {
      continue;
    }

    for (let melIndex = 0; melIndex < N_MELS; melIndex += 1) {
      const filter = state.officialMelFilters[melIndex];
      let total = 0;
      for (let k = 0; k < freqBins; k += 1) {
        total += filter[k] * power[k];
      }
      melSpec[melIndex][frameIndex] = total;
    }
  }

  // Whisper normalization from openai/whisper/audio.py
  let globalMaxLog = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < N_MELS; i += 1) {
    for (let j = 0; j < frameCount; j += 1) {
      const logVal = Math.log10(Math.max(1e-10, melSpec[i][j]));
      if (logVal > globalMaxLog) globalMaxLog = logVal;
      melSpec[i][j] = logVal;
    }
  }

  const floorVal = globalMaxLog - 8.0;
  const flattened = new Float32Array(1 * N_MELS * frameCount);
  for (let i = 0; i < N_MELS; i += 1) {
    for (let j = 0; j < frameCount; j += 1) {
      const clamped = Math.max(melSpec[i][j], floorVal);
      flattened[(i * frameCount) + j] = (clamped + 4.0) / 4.0;
    }
  }

  return new ort.Tensor('float32', flattened, [1, N_MELS, frameCount]);
}

function getAlignmentTimeoutMs(): number {
  const whisperTimeoutMs = getComputeTimeoutConfig().whisperTimeoutMs;
  return Math.max(MIN_ALIGNMENT_TIMEOUT_MS, whisperTimeoutMs - ALIGNMENT_TIMEOUT_BUFFER_MS);
}

function getFfmpegDecodeTimeoutMs(): number {
  const whisperTimeoutMs = getComputeTimeoutConfig().whisperTimeoutMs;
  const halfBudgetMs = Math.floor(whisperTimeoutMs * 0.5);
  return Math.max(
    MIN_FFMPEG_DECODE_TIMEOUT_MS,
    Math.min(MAX_FFMPEG_DECODE_TIMEOUT_MS, halfBudgetMs),
  );
}

async function decodeToPcm16(inputPath: string, outputPath: string): Promise<void> {
  const ffmpegDecodeTimeoutMs = getFfmpegDecodeTimeoutMs();
  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn(getFFmpegPath(), [
      '-y',
      '-i',
      inputPath,
      '-f',
      's16le',
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      '1',
      outputPath,
    ]);

    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ffmpeg.kill('SIGKILL');
    }, ffmpegDecodeTimeoutMs);
    ffmpeg.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffmpeg.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ffmpeg.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`ffmpeg decode timed out after ${ffmpegDecodeTimeoutMs}ms`));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg decode failed with code ${code}: ${stderr}`));
      }
    });
  });
}

function parseLanguageCode(lang?: string): string | null {
  if (!lang) return null;
  const trimmed = lang.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.includes('-')) return trimmed.split('-')[0] || null;
  if (trimmed.includes('_')) return trimmed.split('_')[0] || null;
  return trimmed;
}

function tensorFromInt64(values: number[]): ort.Tensor {
  return new ort.Tensor('int64', BigInt64Array.from(values.map((v) => BigInt(v))), [1, values.length]);
}

function disposeTensor(tensor: ort.Tensor | undefined | null): void {
  if (!tensor) return;
  try {
    tensor.dispose();
  } catch {
    // Best-effort cleanup: ignore disposal errors during fallback path.
  }
}

function disposeTensorMap(tensors: Record<string, ort.Tensor>): void {
  for (const tensor of Object.values(tensors)) {
    disposeTensor(tensor);
  }
}

function computeAdaptiveDecodeStepLimit(maxDecodeSteps: number, textHint?: string): number {
  const normalized = (textHint ?? '').trim();
  if (!normalized) return Math.min(maxDecodeSteps, 96);

  const chars = normalized.length;
  const words = normalized.split(/\s+/).filter(Boolean).length;
  const estTokens = Math.max(words * 3, Math.ceil(chars / 2));
  const adaptive = Math.max(64, Math.min(maxDecodeSteps, estTokens + 24));
  return adaptive;
}

function assertWithinDeadline(deadlineMs: number, timeoutMs: number): void {
  if (Date.now() > deadlineMs) {
    throw new Error(`Whisper alignment timed out after ${timeoutMs}ms`);
  }
}

function makeInFlightCoalesceKey(audioBuffer: TTSAudioBuffer, text: string, lang?: string): string {
  const bytes = new Uint8Array(audioBuffer);
  const span = 4096;
  const head = bytes.subarray(0, Math.min(span, bytes.length));
  const tailStart = Math.max(0, bytes.length - span);
  const tail = bytes.subarray(tailStart);
  return createHash('sha256')
    .update(text)
    .update('\0')
    .update(lang ?? '')
    .update('\0')
    .update(String(bytes.length))
    .update('\0')
    .update(head)
    .update('\0')
    .update(tail)
    .digest('hex');
}

function buildEmptyPastFeeds() {
  if (state.emptyPastFeedsTemplate) return state.emptyPastFeedsTemplate;

  const feeds: Record<string, ort.Tensor> = {};
  const emptyDecoderPast = new Float32Array(0);
  const emptyEncoderPast = new Float32Array(1 * WHISPER_NUM_HEADS * 1500 * WHISPER_HEAD_DIM);

  for (let i = 0; i < WHISPER_NUM_LAYERS; i += 1) {
    feeds[`past_key_values.${i}.decoder.key`] = new ort.Tensor('float32', emptyDecoderPast, [1, WHISPER_NUM_HEADS, 0, WHISPER_HEAD_DIM]);
    feeds[`past_key_values.${i}.decoder.value`] = new ort.Tensor('float32', emptyDecoderPast, [1, WHISPER_NUM_HEADS, 0, WHISPER_HEAD_DIM]);

    // First pass still expects encoder KV inputs in the merged decoder graph.
    feeds[`past_key_values.${i}.encoder.key`] = new ort.Tensor('float32', emptyEncoderPast, [1, WHISPER_NUM_HEADS, 1500, WHISPER_HEAD_DIM]);
    feeds[`past_key_values.${i}.encoder.value`] = new ort.Tensor('float32', emptyEncoderPast, [1, WHISPER_NUM_HEADS, 1500, WHISPER_HEAD_DIM]);
  }

  state.emptyPastFeedsTemplate = feeds;
  return state.emptyPastFeedsTemplate;
}

function argmax(values: Float32Array): number | null {
  let bestIdx = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < values.length; i += 1) {
    const score = values[i];
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  return Number.isFinite(bestScore) ? bestIdx : null;
}

function applyTokenSuppression(logits: Float32Array, tokens: Set<number>) {
  for (const tokenId of tokens) {
    if (tokenId >= 0 && tokenId < logits.length) {
      logits[tokenId] = Number.NEGATIVE_INFINITY;
    }
  }
}

function logSoftmax(input: Float32Array): Float32Array {
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] > max) max = input[i];
  }
  if (!Number.isFinite(max)) {
    return new Float32Array(input.length).fill(Number.NEGATIVE_INFINITY);
  }

  let sum = 0;
  for (let i = 0; i < input.length; i += 1) {
    sum += Math.exp(input[i] - max);
  }
  const logSum = Math.log(sum);

  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    out[i] = input[i] - max - logSum;
  }
  return out;
}

function applyWhisperTimestampLogitsRules(input: {
  logits: Float32Array;
  generated: number[];
  beginIndex: number;
  eosTokenId: number;
  noTimestampsTokenId: number;
  timestampBeginTokenId: number;
  maxInitialTimestampIndex: number;
}) {
  const {
    logits,
    generated,
    beginIndex,
    eosTokenId,
    noTimestampsTokenId,
    timestampBeginTokenId,
    maxInitialTimestampIndex,
  } = input;

  if (noTimestampsTokenId >= 0 && noTimestampsTokenId < logits.length) {
    logits[noTimestampsTokenId] = Number.NEGATIVE_INFINITY;
  }

  if (generated.length === beginIndex) {
    const upper = Math.min(timestampBeginTokenId, logits.length);
    for (let i = 0; i < upper; i += 1) logits[i] = Number.NEGATIVE_INFINITY;
  }

  const seq = generated.slice(beginIndex);
  const lastWasTimestamp = seq.length >= 1 && seq[seq.length - 1] >= timestampBeginTokenId;
  const penultimateWasTimestamp = seq.length < 2 || seq[seq.length - 2] >= timestampBeginTokenId;

  if (lastWasTimestamp) {
    if (penultimateWasTimestamp) {
      for (let i = timestampBeginTokenId; i < logits.length; i += 1) logits[i] = Number.NEGATIVE_INFINITY;
    } else {
      const upper = Math.min(eosTokenId, logits.length);
      for (let i = 0; i < upper; i += 1) logits[i] = Number.NEGATIVE_INFINITY;
    }
  }

  if (generated.length === beginIndex && Number.isFinite(maxInitialTimestampIndex)) {
    const lastAllowed = timestampBeginTokenId + maxInitialTimestampIndex;
    for (let i = lastAllowed + 1; i < logits.length; i += 1) logits[i] = Number.NEGATIVE_INFINITY;
  }

  const textUpper = Math.min(timestampBeginTokenId, logits.length);
  if (textUpper <= 0 || textUpper >= logits.length) return;

  const logprobs = logSoftmax(logits);

  let maxTextTokenLogprob = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < textUpper; i += 1) {
    if (logprobs[i] > maxTextTokenLogprob) maxTextTokenLogprob = logprobs[i];
  }

  let timestampProbMass = 0;
  for (let i = textUpper; i < logprobs.length; i += 1) {
    timestampProbMass += Math.exp(logprobs[i]);
  }
  const timestampLogprob = timestampProbMass > 0 ? Math.log(timestampProbMass) : Number.NEGATIVE_INFINITY;

  if (timestampLogprob > maxTextTokenLogprob) {
    for (let i = 0; i < textUpper; i += 1) logits[i] = Number.NEGATIVE_INFINITY;
  }
}

async function getRuntime(): Promise<WhisperRuntime> {
  if (state.runtimePromise) return state.runtimePromise;

  state.runtimePromise = (async () => {
    await ensureWhisperModel();
    await loadOfficialMelFilters();

    const [configRaw, generationRaw, tokenizerJsonRaw, tokenizerConfigRaw] = await Promise.all([
      readFile(WHISPER_CONFIG_PATH, 'utf8'),
      readFile(WHISPER_GENERATION_CONFIG_PATH, 'utf8'),
      readFile(WHISPER_TOKENIZER_PATH, 'utf8'),
      readFile(WHISPER_TOKENIZER_CONFIG_PATH, 'utf8'),
    ]);

    const config = JSON.parse(configRaw) as {
      decoder_start_token_id?: number;
      eos_token_id?: number;
      forced_decoder_ids?: Array<[number, number | null]>;
    };

    const generationConfig = JSON.parse(generationRaw) as {
      no_timestamps_token_id?: number;
      max_initial_timestamp_index?: number;
      suppress_tokens?: number[];
      begin_suppress_tokens?: number[];
      max_length?: number;
      alignment_heads?: Array<[number, number]>;
    };

    const tokenizer = new Tokenizer(JSON.parse(tokenizerJsonRaw), JSON.parse(tokenizerConfigRaw));

    const promptStartToken = Number(config.decoder_start_token_id ?? 50258);
    const eosTokenId = Number(config.eos_token_id ?? 50257);
    const noTimestampsTokenId = Number(generationConfig.no_timestamps_token_id ?? 50363);
    const timestampBeginTokenId = noTimestampsTokenId + 1;
    const maxInitialTimestampIndex = Number(generationConfig.max_initial_timestamp_index ?? 50);
    const configuredMaxDecodeSteps = Number(generationConfig.max_length ?? 448);
    const maxDecodeSteps = Math.min(configuredMaxDecodeSteps, MAX_DECODE_STEPS_CAP);
    const alignmentHeads = Array.isArray(generationConfig.alignment_heads)
      ? generationConfig.alignment_heads
        .filter((head): head is [number, number] => Array.isArray(head) && head.length === 2)
        .map(([layer, head]) => [Number(layer), Number(head)] as [number, number])
      : [];

    const forcedDecoder = Array.isArray(config.forced_decoder_ids) ? config.forced_decoder_ids : [];
    const defaultLanguageFromForced = forcedDecoder.find(([index, id]) => index === 1 && typeof id === 'number')?.[1] ?? null;
    const transcribeFromForced = forcedDecoder.find(([index, id]) => index === 2 && typeof id === 'number')?.[1] ?? null;

    const defaultLanguageToken = Number(defaultLanguageFromForced ?? tokenizer.token_to_id('<|en|>') ?? 50259);
    const transcribeToken = Number(transcribeFromForced ?? tokenizer.token_to_id('<|transcribe|>') ?? 50359);

    const onnxThreadsPerJob = getOnnxThreadsPerJob();
    const stableSessionOptions: ort.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'],
      // Keep Whisper graph opts disabled: this quantized timestamped model can
      // fail session init under ORT QDQ transform passes (missing *_scale).
      graphOptimizationLevel: 'disabled',
      intraOpNumThreads: onnxThreadsPerJob,
      interOpNumThreads: 1,
      executionMode: 'sequential',
    };

    const encoder = await ort.InferenceSession.create(WHISPER_ENCODER_MODEL_PATH, stableSessionOptions);
    const decoderMerged = await ort.InferenceSession.create(WHISPER_DECODER_MERGED_MODEL_PATH, stableSessionOptions);
    const decoderWithPast = await ort.InferenceSession.create(WHISPER_DECODER_WITH_PAST_MODEL_PATH, stableSessionOptions);

    const alignmentLayers = [...new Set(alignmentHeads.map(([layer]) => layer))];
    const prefillFetches: string[] = ['logits'];
    const stepFetches: string[] = ['logits'];
    const mergedOutputNames = new Set(decoderMerged.outputNames);
    const withPastOutputNames = new Set(decoderWithPast.outputNames);

    for (let i = 0; i < WHISPER_NUM_LAYERS; i += 1) {
      const decoderKey = `present.${i}.decoder.key`;
      const decoderValue = `present.${i}.decoder.value`;
      if (mergedOutputNames.has(decoderKey)) prefillFetches.push(decoderKey);
      if (mergedOutputNames.has(decoderValue)) prefillFetches.push(decoderValue);
      if (withPastOutputNames.has(decoderKey)) stepFetches.push(decoderKey);
      if (withPastOutputNames.has(decoderValue)) stepFetches.push(decoderValue);

      const encoderKey = `present.${i}.encoder.key`;
      const encoderValue = `present.${i}.encoder.value`;
      if (mergedOutputNames.has(encoderKey)) prefillFetches.push(encoderKey);
      if (mergedOutputNames.has(encoderValue)) prefillFetches.push(encoderValue);
    }

    for (const layer of alignmentLayers) {
      const key = `cross_attentions.${layer}`;
      if (mergedOutputNames.has(key)) prefillFetches.push(key);
      if (withPastOutputNames.has(key)) stepFetches.push(key);
    }

    return {
      encoder,
      decoderMerged,
      decoderWithPast,
      tokenizer,
      promptStartToken,
      defaultLanguageToken,
      transcribeToken,
      eosTokenId,
      noTimestampsTokenId,
      timestampBeginTokenId,
      maxInitialTimestampIndex,
      maxDecodeSteps,
      suppressTokens: new Set((generationConfig.suppress_tokens ?? []).map((v) => Number(v))),
      beginSuppressTokens: new Set((generationConfig.begin_suppress_tokens ?? []).map((v) => Number(v))),
      alignmentHeads,
      prefillFetches,
      stepFetches,
    };
  })().catch((error) => {
    state.runtimePromise = null;
    throw error;
  });

  return state.runtimePromise;
}

function resolveLanguageToken(runtime: WhisperRuntime, lang?: string): number {
  const parsed = parseLanguageCode(lang);
  if (!parsed) return runtime.defaultLanguageToken;

  const candidate = runtime.tokenizer.token_to_id(`<|${parsed}|>`);
  return typeof candidate === 'number' ? candidate : runtime.defaultLanguageToken;
}

async function runWhisperOnnx(
  audioSamples: Float32Array,
  opts: WhisperAlignmentOptions,
  numFrames: number,
  deadlineMs: number,
  timeoutMs: number,
): Promise<WhisperWord[]> {
  assertWithinDeadline(deadlineMs, timeoutMs);
  const runtime = await getRuntime();
  const decodeStepLimit = computeAdaptiveDecodeStepLimit(runtime.maxDecodeSteps, opts.textHint);
  const mel = computeLogMelSpectrogram(audioSamples);
  const encoderPast: Record<string, ort.Tensor> = {};
  const decoderPast: Record<string, ort.Tensor> = {};
  const crossAttentions: Record<string, ort.Tensor> = {};
  let encoderHidden: ort.Tensor | null = null;
  let outputs: Record<string, ort.Tensor> | null = null;

  try {
    const encoderOutputs = await runtime.encoder.run({
      input_features: mel,
    }, ['last_hidden_state']);
    encoderHidden = encoderOutputs.last_hidden_state;

    const languageToken = resolveLanguageToken(runtime, opts.lang);
    const promptTokens = [
      runtime.promptStartToken,
      languageToken,
      runtime.transcribeToken,
    ];

    const generated: number[] = [...promptTokens];
    const emptyPastFeeds = buildEmptyPastFeeds();
    type LayerChunk = {
      data: Float32Array;
      heads: number;
      seqLen: number;
      frames: number;
    };
    const selectedHeadsByLayer = new Map<number, number[]>();
    for (const [layer, head] of runtime.alignmentHeads) {
      const existing = selectedHeadsByLayer.get(layer) ?? [];
      if (!existing.includes(head)) existing.push(head);
      selectedHeadsByLayer.set(layer, existing);
    }
    for (const [layer, heads] of selectedHeadsByLayer) {
      heads.sort((a, b) => a - b);
      selectedHeadsByLayer.set(layer, heads);
    }
    const crossAttentionChunks = new Map<number, LayerChunk[]>();

    const captureCrossAttentions = (stepOutputs: Record<string, ort.Tensor>, prefill = false) => {
      for (const [layer, selectedHeads] of selectedHeadsByLayer) {
        const key = `cross_attentions.${layer}`;
        const tensor = stepOutputs[key];
        if (!tensor) continue;
        const [, , seqLen, frames] = tensor.dims;
        const data = tensor.data as Float32Array;
        const rowsToKeep = prefill ? seqLen : 1;
        const seqStart = prefill ? 0 : Math.max(0, seqLen - 1);
        const copied = new Float32Array(selectedHeads.length * rowsToKeep * frames);
        for (let h = 0; h < selectedHeads.length; h += 1) {
          const sourceHead = selectedHeads[h]!;
          for (let s = 0; s < rowsToKeep; s += 1) {
            const sourceSeq = seqStart + s;
            for (let f = 0; f < frames; f += 1) {
              const src = (((sourceHead * seqLen) + sourceSeq) * frames) + f;
              const dst = (((h * rowsToKeep) + s) * frames) + f;
              copied[dst] = data[src] ?? 0;
            }
          }
        }
        const list = crossAttentionChunks.get(layer) ?? [];
        list.push({ data: copied, heads: selectedHeads.length, seqLen: rowsToKeep, frames });
        crossAttentionChunks.set(layer, list);
      }
    };
    const beginIndex = promptTokens.length;

    // Prefill: run prompt in merged decoder (non-cache branch), identical to first
    // forward pass in transformers.js/transformers generation.
    const prefillInputIds = tensorFromInt64(generated);
    const prefillUseCacheBranch = new ort.Tensor('bool', Uint8Array.from([0]), [1]);
    const prefillFeeds: Record<string, ort.Tensor> = {
      input_ids: prefillInputIds,
      encoder_hidden_states: encoderHidden,
      use_cache_branch: prefillUseCacheBranch,
      ...emptyPastFeeds,
    };
    try {
      assertWithinDeadline(deadlineMs, timeoutMs);
      outputs = await runtime.decoderMerged.run(prefillFeeds, runtime.prefillFetches);
    } finally {
      disposeTensor(prefillInputIds);
      disposeTensor(prefillUseCacheBranch);
    }
    captureCrossAttentions(outputs, true);

    for (let i = 0; i < WHISPER_NUM_LAYERS; i += 1) {
      encoderPast[`past_key_values.${i}.encoder.key`] = outputs[`present.${i}.encoder.key`];
      encoderPast[`past_key_values.${i}.encoder.value`] = outputs[`present.${i}.encoder.value`];
      decoderPast[`past_key_values.${i}.decoder.key`] = outputs[`present.${i}.decoder.key`];
      decoderPast[`past_key_values.${i}.decoder.value`] = outputs[`present.${i}.decoder.value`];
    }

    for (let step = 0; step < decodeStepLimit; step += 1) {
      assertWithinDeadline(deadlineMs, timeoutMs);
      if (!outputs) break;
      const logits = outputs.logits;
      const logitsData = logits.data as Float32Array;
      const vocabSize = logits.dims[2] ?? 0;
      const offset = logitsData.length - vocabSize;
      const lastLogits = logitsData.subarray(offset);

      applyTokenSuppression(lastLogits, runtime.suppressTokens);
      if (generated.length === beginIndex) {
        applyTokenSuppression(lastLogits, runtime.beginSuppressTokens);
      }
      applyWhisperTimestampLogitsRules({
        logits: lastLogits,
        generated,
        beginIndex,
        eosTokenId: runtime.eosTokenId,
        noTimestampsTokenId: runtime.noTimestampsTokenId,
        timestampBeginTokenId: runtime.timestampBeginTokenId,
        maxInitialTimestampIndex: runtime.maxInitialTimestampIndex,
      });

      const nextToken = argmax(lastLogits) ?? runtime.eosTokenId;
      generated.push(nextToken);
      if (nextToken === runtime.eosTokenId) break;

      const previousDecoderPast = { ...decoderPast };
      const stepInputIds = tensorFromInt64([nextToken]);
      const stepFeeds: Record<string, ort.Tensor> = {
        input_ids: stepInputIds,
        ...previousDecoderPast,
        ...encoderPast,
      };
      let nextOutputs: Record<string, ort.Tensor>;
      try {
        assertWithinDeadline(deadlineMs, timeoutMs);
        nextOutputs = await runtime.decoderWithPast.run(stepFeeds, runtime.stepFetches);
      } finally {
        disposeTensor(stepInputIds);
      }
      captureCrossAttentions(nextOutputs, false);

      for (let i = 0; i < WHISPER_NUM_LAYERS; i += 1) {
        decoderPast[`past_key_values.${i}.decoder.key`] = nextOutputs[`present.${i}.decoder.key`];
        decoderPast[`past_key_values.${i}.decoder.value`] = nextOutputs[`present.${i}.decoder.value`];
      }

      disposeTensorMap(previousDecoderPast);
      disposeTensor(outputs.logits);
      for (const [name, tensor] of Object.entries(outputs)) {
        if (name.startsWith('cross_attentions.')) {
          disposeTensor(tensor);
        }
      }
      outputs = nextOutputs;
    }

    if (crossAttentionChunks.size === 0) {
      return [];
    }

    const remappedAlignmentHeads: Array<[number, number]> = runtime.alignmentHeads
      .map(([layer, head]) => {
        const selectedHeads = selectedHeadsByLayer.get(layer) ?? [];
        const remappedHead = selectedHeads.indexOf(head);
        if (remappedHead < 0) return null;
        return [layer, remappedHead] as [number, number];
      })
      .filter((pair): pair is [number, number] => pair !== null);

    for (let layer = 0; layer < WHISPER_NUM_LAYERS; layer += 1) {
      const chunks = crossAttentionChunks.get(layer);
      if (!chunks || !chunks.length) continue;

      const heads = chunks[0].heads;
      const frames = chunks[0].frames;
      const concatSeqLen = chunks.reduce((sum, chunk) => sum + chunk.seqLen, 0);
      const merged = new Float32Array(1 * heads * concatSeqLen * frames);
      let seqOffset = 0;

      for (const chunk of chunks) {
        const { data, seqLen, frames: tensorFrames } = chunk;
        const copyFrames = Math.min(frames, tensorFrames);

        for (let h = 0; h < heads; h += 1) {
          for (let s = 0; s < seqLen; s += 1) {
            for (let f = 0; f < copyFrames; f += 1) {
              const src = (((h * seqLen) + s) * tensorFrames) + f;
              const dst = (((h * concatSeqLen) + (seqOffset + s)) * frames) + f;
              merged[dst] = data[src] ?? 0;
            }
          }
        }
        seqOffset += seqLen;
      }

      crossAttentions[`cross_attentions.${layer}`] = new ort.Tensor('float32', merged, [1, heads, concatSeqLen, frames]);
    }

    const tokenStartTimestamps = extractTokenStartTimestamps({
      crossAttentions,
      decoderLayers: WHISPER_NUM_LAYERS,
      alignmentHeads: remappedAlignmentHeads,
      numFrames,
      numInputIds: promptTokens.length,
      timePrecision: 0.02,
      sequenceLength: generated.length,
    });

    const timedWords = buildWordsFromTimestampedTokens({
      tokens: generated,
      tokenStartTimestamps,
      tokenizer: runtime.tokenizer,
      eosTokenId: runtime.eosTokenId,
      promptLength: promptTokens.length,
      timestampBeginTokenId: runtime.timestampBeginTokenId,
      timePrecision: 0.02,
      language: parseLanguageCode(opts.lang) ?? 'english',
    });

    const maxSec = Math.max(0, numFrames * 0.02);
    return timedWords.map((word) => ({
      word: word.word,
      start: Math.min(maxSec, Math.max(0, word.startSec)),
      end: Math.min(maxSec, Math.max(0, word.endSec)),
    }));
  } finally {
    disposeTensor(mel);
    if (outputs?.logits) disposeTensor(outputs.logits);
    if (outputs) {
      for (const [name, tensor] of Object.entries(outputs)) {
        if (name.startsWith('cross_attentions.')) {
          disposeTensor(tensor);
        }
      }
    }
    disposeTensorMap(crossAttentions);
    disposeTensorMap(decoderPast);
    disposeTensorMap(encoderPast);
    disposeTensor(encoderHidden);
  }
}

export async function alignAudioWithText(
  audioBuffer: TTSAudioBuffer,
  text: string,
  cacheKey?: string,
  opts: WhisperAlignmentOptions = {},
): Promise<TTSSentenceAlignment[]> {
  if (!text.trim()) return [];

  if (cacheKey && alignmentCache.has(cacheKey)) {
    const cached = alignmentCache.get(cacheKey)!;
    alignmentCache.delete(cacheKey);
    alignmentCache.set(cacheKey, cached);
    return cached;
  }

  if (cacheKey) {
    const inFlight = alignmentInFlight.get(cacheKey);
    if (inFlight) return inFlight;
  }
  const inFlightKey = cacheKey ?? makeInFlightCoalesceKey(audioBuffer, text, opts.lang);
  const shared = alignmentInFlight.get(inFlightKey);
  if (shared) return shared;

  state.pendingAlignments += 1;
  const run = (async (): Promise<TTSSentenceAlignment[]> => {
    const alignmentTimeoutMs = getAlignmentTimeoutMs();
    const deadlineMs = Date.now() + alignmentTimeoutMs;
    let tmpBase = '';
    let inputPath = '';
    let pcmPath = '';

    try {
      tmpBase = await mkdtemp(join(tmpdir(), 'openreader-whisper-'));
      inputPath = join(tmpBase, `${randomUUID()}-input.bin`);
      pcmPath = join(tmpBase, `${randomUUID()}-input.pcm16`);

      await writeFile(inputPath, Buffer.from(new Uint8Array(audioBuffer)));
      await decodeToPcm16(inputPath, pcmPath);

      const pcmBytes = await readFile(pcmPath);
      const decodedSamples = pcm16ToFloat32(pcmBytes);
      const effectiveSampleLength = Math.min(decodedSamples.length, N_SAMPLES);
      const effectiveFrameCount = Math.max(1, Math.floor((effectiveSampleLength / HOP_LENGTH) / 2));
      const normalizedAudio = padOrTrimAudio(decodedSamples);

      const words = await runWhisperOnnx(
        normalizedAudio,
        { ...opts, textHint: text },
        effectiveFrameCount,
        deadlineMs,
        alignmentTimeoutMs,
      );
      const alignment = mapWordsToSentenceOffsets(text, words);
      const result: TTSSentenceAlignment[] = [alignment];

      if (cacheKey) {
        if (alignmentCache.has(cacheKey)) {
          alignmentCache.delete(cacheKey);
        }
        alignmentCache.set(cacheKey, result);
        while (alignmentCache.size > ALIGNMENT_CACHE_MAX_ENTRIES) {
          const oldest = alignmentCache.keys().next().value;
          if (!oldest) break;
          alignmentCache.delete(oldest);
        }
      }

      return result;
    } finally {
      if (tmpBase) {
        await rm(tmpBase, { recursive: true, force: true }).catch(() => {});
      }
      state.pendingAlignments = Math.max(0, state.pendingAlignments - 1);
    }
  })();

  alignmentInFlight.set(inFlightKey, run);
  run.finally(() => {
    if (alignmentInFlight.get(inFlightKey) === run) {
      alignmentInFlight.delete(inFlightKey);
    }
  });
  return run;
}

export function makeWhisperCacheKey(input: WhisperRequestBody): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        text: input.text,
        lang: input.lang || '',
        audioLen: input.audio?.length || 0,
      }),
    )
    .digest('hex');
}

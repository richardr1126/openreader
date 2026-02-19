import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'crypto';
import { mkdtemp, writeFile, rm, access, mkdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import type { TTSSentenceAlignment, TTSAudioBytes, TTSAudioBuffer } from '@/types/tts';
import { preprocessSentenceForAudio } from '@/lib/shared/nlp';
import { auth } from '@/lib/server/auth/auth';
import { getFFmpegPath } from '@/lib/server/audiobooks/ffmpeg-bin';

export const runtime = 'nodejs';

interface WhisperRequestBody {
  text: string;
  audio: TTSAudioBytes; // raw bytes from Uint8Array
  lang?: string;
}

interface WhisperAlignmentOptions {
  engine?: 'whisper.cpp';
  lang?: string;
}

interface WhisperWord {
  start: number;
  end: number;
  word: string;
}

// Simple in-memory cache keyed by a hash of text+lang+audio length
const alignmentCache = new Map<string, TTSSentenceAlignment[]>();

// Model management using a fixed tiny.en GGML model stored under docstore/model
const MODEL_NAME = 'ggml-tiny.en.bin';
const MODEL_URL =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin';
const DOCSTORE_DIR = join(process.cwd(), 'docstore');
const MODEL_DIR = join(DOCSTORE_DIR, 'model');
const MODEL_PATH = join(MODEL_DIR, MODEL_NAME);
const modelReadyPromises = new Map<string, Promise<void>>();

async function ensureModelAvailable(): Promise<void> {
  // Fast path: model already present
  try {
    await access(MODEL_PATH);
    return;
  } catch {
    // fall through to download
  }

  const existing = modelReadyPromises.get(MODEL_PATH);
  if (existing) return existing;

  const promise = (async () => {
    try {
      await access(MODEL_PATH);
      return;
    } catch {
      // still missing
    }

    await mkdir(MODEL_DIR, { recursive: true });

    const res = await fetch(MODEL_URL);
    if (!res.ok) {
      throw new Error(
        `Failed to download Whisper model from ${MODEL_URL}: ${res.status} ${res.statusText}`
      );
    }

    const arrayBuffer = await res.arrayBuffer();
    await writeFile(MODEL_PATH, Buffer.from(arrayBuffer));
  })();

  modelReadyPromises.set(MODEL_PATH, promise);
  return promise;
}

async function runWhisperCpp(
  wavPath: string,
  opts: WhisperAlignmentOptions
): Promise<WhisperWord[]> {
  const binary = process.env.WHISPER_CPP_BIN;
  if (!binary) {
    throw new Error(
      'Whisper.cpp binary path not configured. Set WHISPER_CPP_BIN to the compiled binary.'
    );
  }

  await ensureModelAvailable();

  return new Promise((resolve, reject) => {
    const jsonBase = `${wavPath}.json_out`;
    const jsonPath = `${jsonBase}.json`;
    // Request full JSON output (including token-level details when available)
    // and ask whisper-cli not to print anything to stdout.
    const args = [
      '-m',
      MODEL_PATH,
      '-f',
      wavPath,
      '-of',
      jsonBase,
      '-ojf',
      '-np',
    ];

    if (opts.lang) {
      args.push('-l', opts.lang);
    }

    const child = spawn(binary, args);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error('whisper-cli exited with error', {
          code,
          wavPath,
          stdout: stdout.slice(0, 500),
          stderr: stderr.slice(0, 500),
        });
        return reject(
          new Error(
            `whisper.cpp exited with code ${code}: ${stderr || stdout}`
          )
        );
      }

      readFile(jsonPath, 'utf-8')
        .then((content: string) => {
          const words: WhisperWord[] = [];
          const parsed = JSON.parse(content) as {
            transcription?: Array<{
              text?: string;
              timestamps?: { from?: string; to?: string };
              offsets?: { from?: number; to?: number };
              tokens?: Array<{
                text?: string;
                timestamps?: { from?: string; to?: string };
                offsets?: { from?: number; to?: number };
              }>;
            }>;
          };

          const transcription = parsed.transcription;

          const parseTimecode = (value?: string): number | null => {
            if (!value) return null;
            const m = value.match(/(\d+):(\d+):(\d+),(\d+)/);
            if (!m) return null;
            const h = Number(m[1]);
            const min = Number(m[2]);
            const s = Number(m[3]);
            const ms = Number(m[4]);
            if (
              Number.isNaN(h) ||
              Number.isNaN(min) ||
              Number.isNaN(s) ||
              Number.isNaN(ms)
            ) {
              return null;
            }
            return h * 3600 + min * 60 + s + ms / 1000;
          };

          if (Array.isArray(transcription)) {
            for (const seg of transcription) {
              const segText = (seg.text || '').trim();
              const segStartSecFromTs = parseTimecode(
                seg.timestamps?.from
              );
              const segEndSecFromTs = parseTimecode(seg.timestamps?.to);
              const segStartSecFromMs =
                typeof seg.offsets?.from === 'number'
                  ? seg.offsets.from / 1000
                  : null;
              const segEndSecFromMs =
                typeof seg.offsets?.to === 'number'
                  ? seg.offsets.to / 1000
                  : null;

              const segStartSec =
                segStartSecFromTs ??
                segStartSecFromMs ??
                0;
              const segEndSec =
                segEndSecFromTs ??
                segEndSecFromMs ??
                segStartSec;

              const tokens = Array.isArray(seg.tokens)
                ? seg.tokens
                : [];

              if (tokens.length > 0) {
                for (const token of tokens) {
                  const rawText = token.text || '';
                  const tokenText = rawText.trim();
                  // Skip special markers like [_BEG_]
                  if (!tokenText || /^\[.*\]$/.test(tokenText)) continue;

                  const tokStartSecFromTs = parseTimecode(
                    token.timestamps?.from
                  );
                  const tokEndSecFromTs = parseTimecode(
                    token.timestamps?.to
                  );
                  const tokStartSecFromMs =
                    typeof token.offsets?.from === 'number'
                      ? token.offsets.from / 1000
                      : null;
                  const tokEndSecFromMs =
                    typeof token.offsets?.to === 'number'
                      ? token.offsets.to / 1000
                      : null;

                  const startSec =
                    tokStartSecFromTs ??
                    tokStartSecFromMs ??
                    segStartSec;
                  const endSec =
                    tokEndSecFromTs ??
                    tokEndSecFromMs ??
                    segEndSec;

                  words.push({
                    word: tokenText,
                    start: startSec,
                    end: endSec,
                  });
                }
              } else if (segText) {
                // Fallback: no token list, approximate per-word timing within the segment
                const segTokens = segText.split(/\s+/).filter(Boolean);
                if (segTokens.length) {
                  const totalDur = Math.max(segEndSec - segStartSec, 0);
                  const step =
                    segTokens.length > 0
                      ? totalDur / segTokens.length
                      : 0;
                  segTokens.forEach((token, index) => {
                    const wStart =
                      step > 0
                        ? segStartSec + step * index
                        : segStartSec;
                    const wEnd =
                      step > 0
                        ? index === segTokens.length - 1
                          ? segEndSec
                          : segStartSec + step * (index + 1)
                        : segEndSec;
                    words.push({
                      word: token,
                      start: wStart,
                      end: wEnd,
                    });
                  });
                }
              }
            }
          }

          resolve(words);
        })
        .catch((err: unknown) => {
          reject(err);
        });
    });
  });
}

function mapWordsToSentenceOffsets(
  sentence: string,
  words: WhisperWord[]
): TTSSentenceAlignment {
  const normalizedSentence = preprocessSentenceForAudio(sentence);
  let cursor = 0;

  const alignedWords = words.map((w) => {
    const token = w.word.trim();
    if (!token) {
      return {
        text: '',
        startSec: w.start,
        endSec: w.end,
        charStart: cursor,
        charEnd: cursor,
      };
    }

    const idx = normalizedSentence
      .toLowerCase()
      .indexOf(token.toLowerCase(), cursor);

    const start =
      idx !== -1
        ? idx
        : cursor;
    const end = start + token.length;

    cursor = end;

    return {
      text: token,
      startSec: w.start,
      endSec: w.end,
      charStart: start,
      charEnd: end,
    };
  });

  return {
    sentence,
    sentenceIndex: 0,
    words: alignedWords.filter((w) => w.text.length > 0),
  };
}

async function alignAudioWithText(
  audioBuffer: TTSAudioBuffer,
  text: string,
  cacheKey?: string,
  opts: WhisperAlignmentOptions = {}
): Promise<TTSSentenceAlignment[]> {
  if (!text.trim()) {
    return [];
  }

  if (cacheKey && alignmentCache.has(cacheKey)) {
    return alignmentCache.get(cacheKey)!;
  }

  const tmpBase = await mkdtemp(join(tmpdir(), 'openreader-whisper-'));
  const inputPath = join(tmpBase, `${randomUUID()}-input.bin`);
  const wavPath = join(tmpBase, `${randomUUID()}-input.wav`);

  try {
    await writeFile(inputPath, Buffer.from(new Uint8Array(audioBuffer)));

    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn(getFFmpegPath(), [
        '-y',
        '-i',
        inputPath,
        '-ar',
        '16000',
        '-ac',
        '1',
        wavPath,
      ]);

      let stderr = '';
      ffmpeg.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      ffmpeg.on('error', (err) => {
        reject(err);
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(`ffmpeg failed with code ${code}: ${stderr}`)
          );
        }
      });
    });

    const words = await runWhisperCpp(wavPath, opts);
    const alignment = mapWordsToSentenceOffsets(text, words);
    const result: TTSSentenceAlignment[] = [alignment];

    if (cacheKey) {
      alignmentCache.set(cacheKey, result);
    }

    return result;
  } finally {
    try {
      await rm(tmpBase, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function makeCacheKey(input: WhisperRequestBody) {
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        text: input.text,
        lang: input.lang || '',
        audioLen: input.audio?.length || 0,
      })
    )
    .digest('hex');
  return hash;
}

export async function POST(req: NextRequest) {
  try {
    // Auth check - require session
    const session = await auth?.api.getSession({ headers: req.headers });
    if (auth && !session?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json()) as WhisperRequestBody;
    const { text, audio, lang } = body;

    if (!text || !audio || !Array.isArray(audio)) {
      return NextResponse.json(
        { error: 'Missing text or audio in request body' },
        { status: 400 }
      );
    }

    const cacheKey = makeCacheKey(body);
    const audioBuffer = new Uint8Array(audio).buffer;

    const alignments: TTSSentenceAlignment[] = await alignAudioWithText(
      audioBuffer,
      text,
      cacheKey,
      { engine: 'whisper.cpp', lang }
    );

    return NextResponse.json({ alignments }, { status: 200 });
  } catch (error) {
    console.error('Error in whisper route:', error);
    return NextResponse.json(
      {
        error: 'WHISPER_ALIGNMENT_FAILED',
        message: 'Failed to compute word-level alignment',
      },
      { status: 500 }
    );
  }
}

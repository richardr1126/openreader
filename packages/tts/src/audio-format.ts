import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ttsLogger } from './logger';

export type SniffedAudioFormat = 'mp3' | 'wav' | 'ogg' | 'flac' | 'aac' | 'unknown';

/**
 * The single MP3 encoding profile every TTS segment is normalized to. Progressive
 * playback concatenates per-segment MP3s into one stream that the browser must be
 * able to seek (so post-generation `playbackRate` works, especially on Safari).
 *
 * Seekability requires the concatenated stream to be byte↔time linear, which holds
 * iff every segment shares:
 *  - a constant bitrate (CBR) — VBR breaks the linear byte→time mapping; with CBR
 *    the browser computes `duration = Content-Length / (bitrate/8)` from the first
 *    frame and seeks by `byte = time × (bitrate/8)`, so no Xing header is needed;
 *  - the same sample rate and channel count — a decoder reads these from the first
 *    frame of the concatenated stream and a mid-stream change garbles the audio.
 *
 * 44.1 kHz mono @ 128 kbps CBR keeps speech clean (the prior VBR q2 profile guarded
 * against low-bitrate high-frequency fatigue; 128k CBR stays comfortably above that)
 * while making the stream seekable. Document export serves this same CBR MP3.
 */
export const STREAM_AUDIO_PROFILE = {
  sampleRateHz: 44100,
  channels: 1,
  bitrateKbps: 128,
} as const;

/** Constant bytes per second of audio for {@link STREAM_AUDIO_PROFILE} (CBR ⇒ linear). */
export const STREAM_AUDIO_BYTES_PER_SECOND = (STREAM_AUDIO_PROFILE.bitrateKbps * 1000) / 8;

/** Samples per MPEG-1 Layer III frame (fixed by the format). */
export const MP3_FRAME_SAMPLES = 1152;

/**
 * Exact decoded duration of one {@link STREAM_AUDIO_PROFILE} MP3 frame. A CBR MP3
 * frame is indivisible: it decodes to exactly this many ms regardless of byte
 * count, and slicing a stream mid-frame drops the partial frame on decode. So any
 * silence we synthesize must be measured in *whole frames* to stay byte↔time
 * accurate — see {@link parseMp3FrameLengths} / {@link cumulativeCbrFrameBytes}.
 */
export const MP3_FRAME_DURATION_MS = (MP3_FRAME_SAMPLES / STREAM_AUDIO_PROFILE.sampleRateHz) * 1000;

// MPEG-1 tables (we only ever parse our own STREAM_AUDIO_PROFILE output).
const MPEG1_L3_BITRATES_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG1_SAMPLE_RATES_HZ = [44100, 48000, 32000, 0];

/**
 * Walk an MPEG-1 Layer III buffer frame by frame and return each frame's byte
 * length (417 or 418 at 128 kbps/44.1 kHz — the CBR padding bit alternates to hold
 * the average bitrate). Skips a leading ID3v2 tag if present. Used to lay out and
 * emit silence on exact frame boundaries so its decoded duration equals the byte
 * length the grid advertises.
 */
export function parseMp3FrameLengths(buffer: Buffer): number[] {
  const lengths: number[] = [];
  let offset = 0;
  if (buffer.length >= 10 && buffer.toString('ascii', 0, 3) === 'ID3') {
    const tagSize =
      ((buffer[6] & 0x7f) << 21)
      | ((buffer[7] & 0x7f) << 14)
      | ((buffer[8] & 0x7f) << 7)
      | (buffer[9] & 0x7f);
    offset = 10 + tagSize;
  }
  while (offset + 4 <= buffer.length) {
    // Frame sync: 11 set bits.
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1;
      continue;
    }
    const version = (buffer[offset + 1] >> 3) & 0x03; // 3 = MPEG-1
    const layer = (buffer[offset + 1] >> 1) & 0x03; // 1 = Layer III
    const bitrateIdx = (buffer[offset + 2] >> 4) & 0x0f;
    const sampleRateIdx = (buffer[offset + 2] >> 2) & 0x03;
    const padding = (buffer[offset + 2] >> 1) & 0x01;
    const bitrateKbps = MPEG1_L3_BITRATES_KBPS[bitrateIdx];
    const sampleRateHz = MPEG1_SAMPLE_RATES_HZ[sampleRateIdx];
    if (version !== 0x03 || layer !== 0x01 || !bitrateKbps || !sampleRateHz) {
      offset += 1; // Not a frame we understand — resync at the next byte.
      continue;
    }
    const frameLength = Math.floor((144000 * bitrateKbps) / sampleRateHz) + padding;
    if (frameLength <= 0 || offset + frameLength > buffer.length) break;
    lengths.push(frameLength);
    offset += frameLength;
  }
  return lengths;
}

/**
 * Total bytes occupied by the first `frameCount` frames of a CBR silence buffer,
 * cycling the frame-length table. Because each frame is whole, this is the *exact*
 * byte length to advertise (and emit) for `frameCount` frames of silence, so the
 * decoded duration (`frameCount × MP3_FRAME_DURATION_MS`) matches the byte grid.
 */
export function cumulativeCbrFrameBytes(frameLengths: number[], frameCount: number): number {
  if (frameLengths.length === 0 || frameCount <= 0) return 0;
  const n = frameLengths.length;
  const cycleBytes = frameLengths.reduce((sum, len) => sum + len, 0);
  const fullCycles = Math.floor(frameCount / n);
  const remainder = frameCount % n;
  let bytes = fullCycles * cycleBytes;
  for (let i = 0; i < remainder; i += 1) bytes += frameLengths[i];
  return bytes;
}

let cachedSilenceFrameLengths: Promise<number[]> | null = null;

/**
 * Frame-length table of {@link getCbrSilenceSecond}, parsed once and cached. Lets
 * the audio stream size and emit silence in whole frames (no mid-frame cuts).
 */
export function getCbrSilenceFrameLengths(): Promise<number[]> {
  if (!cachedSilenceFrameLengths) {
    cachedSilenceFrameLengths = getCbrSilenceSecond()
      .then((buffer) => parseMp3FrameLengths(buffer))
      .catch((error) => {
        cachedSilenceFrameLengths = null; // allow retry
        throw error;
      });
  }
  return cachedSilenceFrameLengths;
}

/**
 * Detect an audio container/codec from a buffer's leading bytes (magic numbers).
 *
 * Biased toward only reporting `mp3` when we are confident, so the common path
 * (a real mp3 from the upstream) skips transcoding, while anything ambiguous is
 * normalized through ffmpeg rather than mislabeled as mp3.
 */
export function sniffAudioFormat(buffer: Buffer): SniffedAudioFormat {
  if (buffer.length < 4) return 'unknown';

  // RIFF....WAVE
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer.length >= 12 &&
    buffer[8] === 0x57 && buffer[9] === 0x41 && buffer[10] === 0x56 && buffer[11] === 0x45
  ) {
    return 'wav';
  }

  // OggS
  if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) {
    return 'ogg';
  }

  // fLaC
  if (buffer[0] === 0x66 && buffer[1] === 0x4c && buffer[2] === 0x61 && buffer[3] === 0x43) {
    return 'flac';
  }

  // ID3-tagged mp3 (the ID3v2 header is 10 bytes: "ID3" + version + flags + size).
  if (buffer.length >= 10 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return 'mp3';
  }

  // MPEG/AAC frame sync: 11 bits set (0xFFE_). Validate the rest of the 4-byte
  // header so we only claim mp3 on a plausibly-valid frame; ambiguous bytes fall
  // through to ffmpeg normalization. Disambiguate mp3 vs ADTS-AAC via the layer
  // bits — mp3 never uses layer `00`, ADTS always does.
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    const layerBits = (buffer[1] >> 1) & 0x03;
    if (layerBits === 0) return 'aac';
    const versionBits = (buffer[1] >> 3) & 0x03;    // 0b01 is reserved/invalid
    const bitrateBits = (buffer[2] >> 4) & 0x0f;     // 0b1111 is the "bad" index
    const sampleRateBits = (buffer[2] >> 2) & 0x03;  // 0b11 is reserved
    if (versionBits === 1 || bitrateBits === 0x0f || sampleRateBits === 3) {
      return 'unknown';
    }
    return 'mp3';
  }

  return 'unknown';
}

function spawnFfmpegToBuffer(args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('ABORTED'));
      return;
    }

    let ffmpeg: ReturnType<typeof spawn> | null = null;
    let finished = false;

    // Register abort handling before the async import so a cancel fired during the
    // lazy module load is honored and we never spawn ffmpeg after an abort.
    const onAbort = () => {
      if (finished) return;
      finished = true;
      try {
        ffmpeg?.kill('SIGKILL');
      } catch {}
      reject(new Error('ABORTED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // Resolve lazily so ffmpeg-static is only loaded in server runtimes that need it.
    import('./ffmpeg-bin')
      .then(({ getFFmpegPath }) => {
        if (finished) return; // aborted during the import
        const child = spawn(getFFmpegPath(), args);
        ffmpeg = child;
        const stdoutChunks: Buffer[] = [];
        let stderr = '';

        child.stdout.on('data', (chunk: Buffer) => {
          stdoutChunks.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });

        child.on('close', (code) => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener('abort', onAbort);
          if (code === 0) {
            resolve(Buffer.concat(stdoutChunks));
          } else {
            reject(new Error(`ffmpeg transcode exited with code ${code}: ${stderr.slice(-500)}`));
          }
        });

        child.on('error', (err) => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        });
      })
      .catch((err) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        reject(err);
      });
  });
}

/**
 * Transcode an arbitrary audio buffer to a {@link STREAM_AUDIO_PROFILE} mp3 using
 * the bundled ffmpeg. The input is written to a temp file (ffmpeg needs seekable
 * input for some containers) and the mp3 is read back from a temp file.
 *
 * Emits CBR (`-b:a`), a fixed sample rate (`-ar`) and mono (`-ac`) so every segment
 * shares one byte↔time-linear profile and concatenates into a seekable stream — see
 * {@link STREAM_AUDIO_PROFILE}. `-write_xing 0` drops the Xing/Info header: for CBR
 * it carries no useful duration (we serve a known Content-Length), and a per-segment
 * Xing frame would decode as ~26ms of silence mid-stream, breaking gapless playback.
 */
export async function transcodeToMp3(buffer: Buffer, signal?: AbortSignal): Promise<Buffer> {
  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), 'openreader-tts-transcode-'));
    const inputPath = join(workDir, 'input');
    const outputPath = join(workDir, 'output.mp3');
    await writeFile(inputPath, buffer);

    await spawnFfmpegToBuffer(
      [
        '-nostdin',
        '-loglevel', 'error',
        '-y',
        '-i', inputPath,
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', `${STREAM_AUDIO_PROFILE.bitrateKbps}k`,
        '-ar', String(STREAM_AUDIO_PROFILE.sampleRateHz),
        '-ac', String(STREAM_AUDIO_PROFILE.channels),
        '-write_xing', '0',
        '-f', 'mp3',
        outputPath,
      ],
      signal,
    );

    return await readFile(outputPath);
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

let cachedSilenceSecond: Promise<Buffer> | null = null;

/**
 * One second of {@link STREAM_AUDIO_PROFILE} CBR silence, generated once via ffmpeg
 * and cached. Used to pad the tail of a progressive stream up to its advertised
 * Content-Length with *valid* MP3 frames (not zero bytes), so the browser decodes
 * cleanly to the end and fires `ended` rather than stalling on garbage. Because the
 * profile is CBR, this fixed buffer can be repeated/sliced to fill any byte length.
 */
export function getCbrSilenceSecond(signal?: AbortSignal): Promise<Buffer> {
  if (!cachedSilenceSecond) {
    cachedSilenceSecond = spawnFfmpegToBuffer(
      [
        '-nostdin',
        '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', `anullsrc=r=${STREAM_AUDIO_PROFILE.sampleRateHz}:cl=mono`,
        '-t', '1',
        '-c:a', 'libmp3lame',
        '-b:a', `${STREAM_AUDIO_PROFILE.bitrateKbps}k`,
        '-ar', String(STREAM_AUDIO_PROFILE.sampleRateHz),
        '-ac', String(STREAM_AUDIO_PROFILE.channels),
        '-write_xing', '0',
        '-f', 'mp3',
        'pipe:1',
      ],
      signal,
    ).catch((error) => {
      // Don't cache a rejected promise — allow a later retry.
      cachedSilenceSecond = null;
      throw error;
    });
  }
  return cachedSilenceSecond;
}

/**
 * Normalize a TTS buffer to a {@link STREAM_AUDIO_PROFILE} mp3. Every segment is
 * (re)encoded to the one CBR/sample-rate/channel profile — including inputs that
 * are already mp3 — because progressive playback concatenates these segments into a
 * single seekable stream and a provider's own mp3 (VBR, or a different bitrate /
 * sample rate / channel count) would break the byte↔time linearity that seeking and
 * post-generation `playbackRate` depend on. Segment audio is cached, so this one-time
 * transcode cost is amortized across every playback and MP3 export.
 */
export async function normalizeToMp3(buffer: Buffer, signal?: AbortSignal): Promise<Buffer> {
  if (buffer.length === 0) return buffer;

  const format = sniffAudioFormat(buffer);
  const transcoded = await transcodeToMp3(buffer, signal);
  ttsLogger.info({
    event: 'tts.audio_format.normalized_to_mp3',
    sourceFormat: format,
    sourceBytes: buffer.length,
    outputBytes: transcoded.length,
  }, 'Normalized TTS audio to stream profile mp3');
  return transcoded;
}

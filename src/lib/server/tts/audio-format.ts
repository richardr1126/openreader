import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { serverLogger } from '@/lib/server/logger';

export type SniffedAudioFormat = 'mp3' | 'wav' | 'ogg' | 'flac' | 'aac' | 'unknown';

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

  // ID3-tagged mp3
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return 'mp3';
  }

  // MPEG/AAC frame sync: 11 bits set (0xFFE_). Disambiguate mp3 vs ADTS-AAC via
  // the 2 layer bits — mp3 never uses layer `00`, ADTS always does.
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    const layerBits = buffer[1] & 0x06;
    return layerBits === 0 ? 'aac' : 'mp3';
  }

  return 'unknown';
}

function spawnFfmpegToBuffer(args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    // Resolve lazily so ffmpeg-static is only loaded in server runtimes that need it.
    import('@/lib/server/audiobooks/ffmpeg-bin')
      .then(({ getFFmpegPath }) => {
        const ffmpeg = spawn(getFFmpegPath(), args);
        const stdoutChunks: Buffer[] = [];
        let stderr = '';
        let finished = false;

        const onAbort = () => {
          if (finished) return;
          finished = true;
          try {
            ffmpeg.kill('SIGKILL');
          } catch {}
          reject(new Error('ABORTED'));
        };

        if (signal) {
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        }

        ffmpeg.stdout.on('data', (chunk: Buffer) => {
          stdoutChunks.push(chunk);
        });
        ffmpeg.stderr.on('data', (chunk) => {
          stderr += String(chunk);
        });

        ffmpeg.on('close', (code) => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener('abort', onAbort);
          if (code === 0) {
            resolve(Buffer.concat(stdoutChunks));
          } else {
            reject(new Error(`ffmpeg transcode exited with code ${code}: ${stderr.slice(-500)}`));
          }
        });

        ffmpeg.on('error', (err) => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        });
      })
      .catch(reject);
  });
}

/**
 * Transcode an arbitrary audio buffer to mp3 using the bundled ffmpeg. The input
 * is written to a temp file (ffmpeg needs seekable input for some containers) and
 * the mp3 is captured from stdout.
 *
 * Uses VBR quality 2 (~170-210 kbps) rather than a low CBR bitrate: this audio is
 * what the user listens to live, and aggressive low-bitrate encoding of pristine
 * high-fidelity TTS (e.g. 44.1 kHz wav) introduces high-frequency artifacts that
 * cause listening fatigue. The audiobook export still re-encodes to 64k for size.
 */
export async function transcodeToMp3(buffer: Buffer, signal?: AbortSignal): Promise<Buffer> {
  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), 'openreader-tts-transcode-'));
    const inputPath = join(workDir, 'input');
    await writeFile(inputPath, buffer);

    return await spawnFfmpegToBuffer(
      [
        '-nostdin',
        '-loglevel', 'error',
        '-i', inputPath,
        '-vn',
        '-c:a', 'libmp3lame',
        '-q:a', '2',
        '-f', 'mp3',
        'pipe:1',
      ],
      signal,
    );
  } finally {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Ensure a TTS buffer is mp3. OpenAI-compatible servers vary in which audio
 * formats they emit (some default to or only support wav), so we sniff the bytes
 * and transcode anything that isn't already mp3. Real-mp3 responses pass through
 * untouched, so the common path adds zero cost.
 */
export async function normalizeToMp3(buffer: Buffer, signal?: AbortSignal): Promise<Buffer> {
  if (buffer.length === 0) return buffer;

  const format = sniffAudioFormat(buffer);
  if (format === 'mp3') return buffer;

  const transcoded = await transcodeToMp3(buffer, signal);
  serverLogger.info({
    event: 'tts.audio_format.normalized_to_mp3',
    sourceFormat: format,
    sourceBytes: buffer.length,
    outputBytes: transcoded.length,
  }, 'Normalized non-mp3 TTS audio to mp3');
  return transcoded;
}

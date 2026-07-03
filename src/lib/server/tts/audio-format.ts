import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
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
    import('@/lib/server/audiobooks/ffmpeg-bin')
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
 * Transcode an arbitrary audio buffer to mp3 using the bundled ffmpeg. The input
 * is written to a temp file (ffmpeg needs seekable input for some containers) and
 * the mp3 is captured from stdout.
 *
 * Uses VBR quality 2 (~170-210 kbps) rather than a low CBR bitrate: this audio is
 * what the user listens to live, and aggressive low-bitrate encoding of pristine
 * high-fidelity TTS (e.g. 44.1 kHz wav) introduces high-frequency artifacts that
 * cause listening fatigue. The audiobook export still re-encodes to 64k for size.
 *
 * The mp3 is written to a seekable temp file rather than piped to stdout: VBR mp3
 * stores its total-duration metadata in a Xing/Info header at the *start* of the
 * file, which ffmpeg can only emit by seeking back after encoding finishes. On a
 * pipe that seek is impossible, so a piped VBR mp3 carries no valid duration. The
 * HTML5 <audio> element then extrapolates duration from the first frame's bitrate
 * (correct for CBR, wrong for VBR), which makes the `ended` event fire at the
 * wrong time — or stall without firing — and stops segment-to-segment playback.
 * Writing to a real file lets ffmpeg backpatch the Xing header so duration is
 * accurate and `ended` fires reliably.
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
        '-q:a', '2',
        '-write_xing', '1',
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

/**
 * Detects an mp3 whose leading Xing/Info VBR header under-reports the stream
 * size — the fingerprint of concatenated mp3 chunks. Some OpenAI-compatible TTS
 * servers (e.g. DeepInfra's Kokoro) stream audio as several independent mp3
 * segments glued together but keep only the *first* chunk's Xing header. The
 * HTML5 <audio> element trusts that header for VBR duration, so it plays only the
 * first chunk (~2s) and fires `ended` early — the rest of the segment is silently
 * skipped. We compare the Xing-declared byte count to the real buffer length.
 */
function hasUnderreportingXingHeader(buffer: Buffer): boolean {
  const searchEnd = Math.min(buffer.length, 4096);
  let tagPos = -1;
  for (const tag of ['Xing', 'Info']) {
    const p = buffer.indexOf(tag, 0, 'latin1');
    if (p >= 0 && p < searchEnd) { tagPos = p; break; }
  }
  if (tagPos < 0 || tagPos + 8 > buffer.length) return false;
  const flags = buffer.readUInt32BE(tagPos + 4);
  let cursor = tagPos + 8;
  if (flags & 0x1) cursor += 4; // frames field present — skip it
  if (!(flags & 0x2)) return false; // no byte-count field to validate against
  if (cursor + 4 > buffer.length) return false;
  const declaredBytes = buffer.readUInt32BE(cursor);
  if (declaredBytes <= 0) return false;
  // A well-formed Xing describes ~the whole file; a concatenated file's header
  // describes only the first chunk, far below the real size.
  return declaredBytes < buffer.length * 0.7;
}

/**
 * Ensure a TTS buffer is mp3. OpenAI-compatible servers vary in which audio
 * formats they emit (some default to or only support wav), so we sniff the bytes
 * and transcode anything that isn't already mp3. Real-mp3 responses pass through
 * untouched, so the common path adds zero cost — except concatenated-chunk mp3
 * with a broken Xing header, which is re-encoded so its duration is accurate and
 * HTML5 playback doesn't truncate mid-segment.
 */
export async function normalizeToMp3(buffer: Buffer, signal?: AbortSignal): Promise<Buffer> {
  if (buffer.length === 0) return buffer;

  const format = sniffAudioFormat(buffer);
  if (format === 'mp3') {
    if (!hasUnderreportingXingHeader(buffer)) return buffer;
    const repaired = await transcodeToMp3(buffer, signal);
    serverLogger.info({
      event: 'tts.audio_format.repaired_mp3_xing',
      sourceBytes: buffer.length,
      outputBytes: repaired.length,
    }, 'Repaired concatenated mp3 with under-reporting Xing header');
    return repaired;
  }

  const transcoded = await transcodeToMp3(buffer, signal);
  serverLogger.info({
    event: 'tts.audio_format.normalized_to_mp3',
    sourceFormat: format,
    sourceBytes: buffer.length,
    outputBytes: transcoded.length,
  }, 'Normalized non-mp3 TTS audio to mp3');
  return transcoded;
}

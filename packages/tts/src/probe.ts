import { spawn } from 'child_process';
import { getFFmpegPath } from './ffmpeg-bin';

export interface ProbeResult {
  durationSec?: number;
}

function parseDurationFromStderr(stderr: string): number | undefined {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (![hours, minutes, seconds].every(Number.isFinite)) return undefined;
  return hours * 3600 + minutes * 60 + seconds;
}

export async function ffprobeAudio(filePath: string, signal?: AbortSignal): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve, reject) => {
    const ffmpeg = spawn(getFFmpegPath(), ['-i', filePath, '-f', 'ffmetadata', '-']);
    let stderr = '';
    let finished = false;

    const onAbort = () => {
      if (finished) return;
      finished = true;
      try { ffmpeg.kill('SIGKILL'); } catch {}
      reject(new Error('ABORTED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    ffmpeg.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    ffmpeg.on('error', (error) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    ffmpeg.on('close', () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      resolve({ durationSec: parseDurationFromStderr(stderr) });
    });
  });
}

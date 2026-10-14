import fs from 'fs';

/**
 * The one ffmpeg executable every worker caller spawns. Docker images and desktop
 * packages set FFMPEG_BIN to the pinned LGPL build from packaging/ffmpeg; in
 * development the bootstrap fills it from the ffmpeg-static dev dependency.
 * Without it, `ffmpeg` is looked up on PATH.
 */
export function getFFmpegPath(): string {
  const configured = process.env.FFMPEG_BIN?.trim();
  if (!configured) return 'ffmpeg';
  if ((configured.includes('/') || configured.includes('\\')) && !fs.existsSync(configured)) {
    throw new Error(`FFMPEG_BIN points to a missing binary: ${configured}`);
  }
  return configured;
}

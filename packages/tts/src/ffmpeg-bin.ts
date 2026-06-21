import ffmpegPath from 'ffmpeg-static';

export function getFFmpegPath(): string {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static did not provide an executable path');
  }
  return ffmpegPath;
}

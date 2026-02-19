import { existsSync } from 'fs';
import ffmpegStatic from 'ffmpeg-static';

function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveBinary(envValue: string | null, bundledValue: string | null, envVarName: string, packageName: string): string {
  if (envValue) {
    if ((envValue.includes('/') || envValue.includes('\\')) && !existsSync(envValue)) {
      throw new Error(`${envVarName} points to a missing binary: ${envValue}`);
    }
    return envValue;
  }

  if (!bundledValue) {
    throw new Error(
      `${packageName} binary is unavailable on this platform. Set ${envVarName} to an installed binary path.`,
    );
  }

  if ((bundledValue.includes('/') || bundledValue.includes('\\')) && !existsSync(bundledValue)) {
    throw new Error(`${packageName} resolved to a missing binary path: ${bundledValue}`);
  }
  return bundledValue;
}

export function getFFmpegPath(): string {
  return resolveBinary(
    normalizePath(process.env.FFMPEG_BIN),
    normalizePath(ffmpegStatic),
    'FFMPEG_BIN',
    'ffmpeg-static',
  );
}

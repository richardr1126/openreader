import fs from 'fs';
import path from 'path';
import ffmpegStatic from 'ffmpeg-static';

function findMonorepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  for (;;) {
    const marker = path.join(current, 'pnpm-workspace.yaml');
    if (fs.existsSync(marker)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveDocstoreDir(): string {
  const repoRoot = findMonorepoRoot(process.cwd());
  if (repoRoot) return path.join(repoRoot, 'docstore');
  return path.join(process.cwd(), 'docstore');
}

export const DOCSTORE_DIR = resolveDocstoreDir();

function normalizePath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveBinary(envValue: string | null, bundledValue: string | null, envVarName: string, packageName: string): string {
  if (envValue) {
    if ((envValue.includes('/') || envValue.includes('\\')) && !fs.existsSync(envValue)) {
      throw new Error(`${envVarName} points to a missing binary: ${envValue}`);
    }
    return envValue;
  }
  if (!bundledValue) {
    throw new Error(`${packageName} binary is unavailable on this platform. Set ${envVarName} to an installed binary path.`);
  }
  if ((bundledValue.includes('/') || bundledValue.includes('\\')) && !fs.existsSync(bundledValue)) {
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

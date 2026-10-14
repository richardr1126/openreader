// Verified downloads and archive extraction for the packaging scripts
// (packaging/ffmpeg/fetch.mjs, desktop/scripts/stage.mjs).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Streams `url` to `file` and throws unless its SHA-256 equals `expectedSha256`. */
export async function downloadVerified(url, file, expectedSha256) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  const hash = createHash('sha256');
  await pipeline(
    Readable.fromWeb(response.body),
    async function* (chunks) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        yield chunk;
      }
    },
    fs.createWriteStream(file),
  );
  const actual = hash.digest('hex');
  if (actual !== expectedSha256) {
    fs.rmSync(file, { force: true });
    throw new Error(`SHA-256 mismatch for ${url}\n  expected ${expectedSha256}\n  received ${actual}`);
  }
}

/**
 * Extracts a .tar.gz, .tar.xz or .zip into `dir` with the system tar. bsdtar
 * (macOS, Windows) reads all three; GNU tar (Linux) cannot read zip, so Linux
 * uses unzip for those.
 */
export function extractArchive(archive, dir) {
  const zipOnLinux = archive.endsWith('.zip') && process.platform === 'linux';
  const [cmd, args] = zipOnLinux ? ['unzip', ['-q', archive, '-d', dir]] : ['tar', ['-xf', archive, '-C', dir]];
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Could not extract ${archive} with ${cmd}`);
}

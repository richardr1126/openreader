#!/usr/bin/env node
// Downloads the pinned LGPL ffmpeg for one target from the release named in
// manifest.json, verifies its SHA-256, and writes ffmpeg (or ffmpeg.exe),
// LICENSE.txt and SOURCE.txt into --out. When the
// target can run on this machine, it also runs the licence and operation smoke
// test. Docker images and desktop packages ship exactly this output.
//
// Usage: node packaging/ffmpeg/fetch.mjs --out <dir> [--target <name>]
//   <name> is a key of manifest.json's targets; the default is this machine.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { smokeTestFfmpeg } from './smoke-test.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'));

function hostTarget() {
  if (process.platform === 'darwin') return 'darwin-universal';
  return `${process.platform}-${process.arch}`;
}

function parseArgs(argv) {
  const args = { target: hostTarget(), out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--target') args.target = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.out) throw new Error('Usage: node packaging/ffmpeg/fetch.mjs --out <dir> [--target <name>]');
  return args;
}

async function download(url, file, expectedSha256) {
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
    throw new Error(`SHA-256 mismatch for ${url}\n  expected ${expectedSha256}\n  received ${actual}`);
  }
}

function extract(archive, dir) {
  const result = spawnSync('tar', ['-xzf', archive, '-C', dir], { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error(`Could not extract ${path.basename(archive)} with tar`);
}

async function main() {
  const { target, out } = parseArgs(process.argv.slice(2));
  if (!(target in manifest.sha256)) {
    throw new Error(`No ffmpeg pinned for "${target}". Known targets: ${Object.keys(manifest.sha256).join(', ')}`);
  }
  const sha256 = manifest.sha256[target];
  if (!sha256) {
    throw new Error(`ffmpeg for ${target} is not pinned yet: publish the ${manifest.release} release with the ffmpeg workflow, then record its SHA-256 in packaging/ffmpeg/manifest.json.`);
  }
  const name = `ffmpeg-${manifest.ffmpegVersion}-lgpl-${target}`;
  const releaseUrl = `https://github.com/richardr1126/openreader/releases/tag/${manifest.release}`;
  const url = `https://github.com/richardr1126/openreader/releases/download/${manifest.release}/${name}.tar.gz`;

  const exe = target.startsWith('win32-') ? 'ffmpeg.exe' : 'ffmpeg';
  const binaryOut = path.join(out, exe);
  const sourceOut = path.join(out, 'SOURCE.txt');
  const provenance = [
    `FFmpeg ${manifest.ffmpegVersion} for ${target}, ${manifest.license}`,
    `Built by packaging/ffmpeg/build.sh: ${url}`,
    `SHA-256 of that archive: ${sha256}`,
    `Corresponding source (FFmpeg and LAME sources, build script): ${releaseUrl}`,
    '',
  ].join('\n');
  if (fs.existsSync(binaryOut) && fs.existsSync(sourceOut) && fs.readFileSync(sourceOut, 'utf8') === provenance) {
    console.log(`[ffmpeg] ${target} already in ${out}`);
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openreader-ffmpeg-'));
  try {
    const archive = path.join(work, `${name}.tar.gz`);
    console.log(`[ffmpeg] downloading ${target} from ${url}`);
    await download(url, archive, sha256);
    extract(archive, work);

    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(path.join(work, name, 'bin', exe), binaryOut);
    fs.chmodSync(binaryOut, 0o755);
    fs.copyFileSync(path.join(work, name, 'LICENSE.txt'), path.join(out, 'LICENSE.txt'));
    fs.writeFileSync(sourceOut, provenance);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  if (target === hostTarget()) {
    smokeTestFfmpeg(binaryOut);
    console.log(`[ffmpeg] ${target}: LGPL build, all OpenReader operations pass`);
  } else {
    console.log(`[ffmpeg] ${target}: verified by SHA-256 (cannot run on ${hostTarget()} for the smoke test)`);
  }
}

main().catch((error) => {
  console.error(`[ffmpeg] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

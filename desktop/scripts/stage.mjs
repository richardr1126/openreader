#!/usr/bin/env node
// Assembles the runtime the desktop app bundles into desktop/stage/runtime, for
// this machine's platform and architecture. It is the Docker image's layout (the
// standalone Next.js app plus the deployed bootstrap and worker) with Node.js,
// NATS, SeaweedFS and ffmpeg beside it:
//
//   node/                      node (node.exe) and its LICENSE
//   app/                       .next/standalone, .next/static, public
//   bootstrap/                 pnpm deploy of @openreader/bootstrap
//   embedded-compute-worker/   pnpm deploy --prod of @openreader/compute-worker
//   bin/                       nats-server, weed
//   ffmpeg/                    ffmpeg, LICENSE.txt, SOURCE.txt (packaging/ffmpeg)
//   licenses/                  NATS and SeaweedFS licence texts
//
// Native modules come from this checkout's install, so staging runs on the
// platform it packages and bundles the Node.js version that is running it.
// Run `pnpm build` first.
//
// Usage: node desktop/scripts/stage.mjs [--ffmpeg-dir <dir>]
//   --ffmpeg-dir  copy a directory laid out like fetch.mjs output instead of
//                 fetching the pinned ffmpeg (a local build before it is pinned)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadVerified, extractArchive } from '../../packaging/download.mjs';
import { sourceTreeId } from './source-tree.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopDir, '..');
const runtimeDir = path.join(desktopDir, 'stage', 'runtime');
const sourceStampFile = path.join(desktopDir, 'stage', 'source-tree');
const target = `${process.platform}-${process.arch}`;
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);
const pins = JSON.parse(fs.readFileSync(path.join(desktopDir, 'runtime-binaries.json'), 'utf8'));

function parseArgs(argv) {
  const args = { ffmpegDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--ffmpeg-dir') args.ffmpegDir = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.error || result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
}

function findFile(root, name) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === name) return path.join(entry.parentPath, entry.name);
  }
  throw new Error(`${name} not found in ${root}`);
}

function copyExecutable(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o755);
}

/** Downloads and unpacks an archive into a fresh temporary directory. */
async function unpack(url, sha256) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openreader-stage-'));
  const archive = path.join(work, path.basename(new URL(url).pathname));
  console.log(`[stage] downloading ${url}`);
  await downloadVerified(url, archive, sha256);
  const dir = path.join(work, 'unpacked');
  fs.mkdirSync(dir);
  extractArchive(archive, dir);
  return dir;
}

async function stageNode() {
  const version = process.version;
  const platform = { darwin: 'darwin', linux: 'linux', win32: 'win' }[process.platform];
  const file = `node-${version}-${platform}-${process.arch}.${process.platform === 'win32' ? 'zip' : 'tar.xz'}`;
  const sums = await (await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
  const line = sums.split('\n').find((entry) => entry.endsWith(`  ${file}`));
  if (!line) throw new Error(`nodejs.org lists no ${file}`);
  const dir = await unpack(`https://nodejs.org/dist/${version}/${file}`, line.split(' ')[0]);
  const root = path.join(dir, path.basename(file).replace(/\.(zip|tar\.xz)$/, ''));
  const binary = process.platform === 'win32' ? path.join(root, 'node.exe') : path.join(root, 'bin', 'node');
  copyExecutable(binary, path.join(runtimeDir, 'node', exe('node')));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(runtimeDir, 'node', 'LICENSE'));
  if (process.platform === 'linux') stageNodeLibraries(binary);
}

/**
 * Node.js for Linux links libatomic, which minimal and some desktop installs
 * lack, so the runtime carries the build machine's copy in node/lib
 * (src/runtime.mjs puts it on the loader path). It is GCC runtime code, which
 * the GCC Runtime Library Exception lets us redistribute.
 */
function stageNodeLibraries(binary) {
  const ldd = spawnSync('ldd', [binary], { encoding: 'utf8' });
  if (ldd.status !== 0) throw new Error(`ldd ${binary} failed: ${ldd.stderr}`);
  const line = ldd.stdout.split('\n').find((entry) => entry.trim().startsWith('libatomic.so.1'));
  if (!line) return;
  const source = line.match(/=>\s*(\S+)/)?.[1];
  if (!source || !source.startsWith('/')) {
    throw new Error('Node.js needs libatomic.so.1, which this machine lacks: install libatomic1.');
  }
  const lib = path.join(runtimeDir, 'node', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(fs.realpathSync(source), path.join(lib, 'libatomic.so.1'));
}

function stageApp() {
  const serverFiles = path.join(repoRoot, '.next', 'required-server-files.json');
  if (!fs.existsSync(serverFiles)) throw new Error('.next is missing: run `pnpm build` first.');
  // Standalone output mirrors the app's path below the file-tracing root, which
  // is a parent directory when the checkout is nested (a git worktree, say).
  const { relativeAppDir } = JSON.parse(fs.readFileSync(serverFiles, 'utf8'));
  const standalone = path.join(repoRoot, '.next', 'standalone', relativeAppDir ?? '');
  if (!fs.existsSync(path.join(standalone, 'server.js'))) {
    throw new Error(`${path.relative(repoRoot, standalone)}/server.js is missing: run \`pnpm build\` first.`);
  }
  const appDir = path.join(runtimeDir, 'app');
  fs.cpSync(standalone, appDir, { recursive: true, verbatimSymlinks: true });
  fs.cpSync(path.join(repoRoot, '.next', 'static'), path.join(appDir, '.next', 'static'), { recursive: true });
  fs.cpSync(path.join(repoRoot, 'public'), path.join(appDir, 'public'), { recursive: true });
  // Next copies the checkout's .env files into standalone output; they hold the
  // developer's secrets and must never ship. The shell provides all settings.
  for (const name of fs.readdirSync(appDir)) {
    if (name.startsWith('.env')) fs.rmSync(path.join(appDir, name));
  }
}

function stageDeployments() {
  // The same deployments the Docker image ships.
  run('pnpm', ['--config.inject-workspace-packages=true', '--filter', '@openreader/bootstrap', 'deploy', path.join(runtimeDir, 'bootstrap')], { cwd: repoRoot });
  run('pnpm', ['--dir', path.join(runtimeDir, 'bootstrap'), 'rebuild', 'better-sqlite3'], { cwd: repoRoot });
  if (!fs.existsSync(path.join(repoRoot, 'packages', 'compute-worker', 'dist', 'server.js'))) {
    throw new Error('packages/compute-worker/dist is missing: run `pnpm build` first.');
  }
  run('pnpm', ['--config.inject-workspace-packages=true', '--filter', '@openreader/compute-worker', 'deploy', '--prod', path.join(runtimeDir, 'embedded-compute-worker')], { cwd: repoRoot });
}

/**
 * onnxruntime-node ships its native library for every platform (about 280 MB);
 * keep only this target's.
 */
function pruneOnnxRuntime() {
  const bin = path.join(runtimeDir, 'embedded-compute-worker', 'node_modules', 'onnxruntime-node', 'bin');
  for (const napi of fs.readdirSync(bin)) {
    for (const platform of fs.readdirSync(path.join(bin, napi))) {
      const platformDir = path.join(bin, napi, platform);
      if (platform !== process.platform) {
        fs.rmSync(platformDir, { recursive: true });
        continue;
      }
      for (const arch of fs.readdirSync(platformDir)) {
        if (arch !== process.arch) fs.rmSync(path.join(platformDir, arch), { recursive: true });
      }
    }
  }
  const kept = fs.readdirSync(bin).some((napi) => fs.existsSync(path.join(bin, napi, process.platform, process.arch)));
  if (!kept) throw new Error(`onnxruntime-node has no ${target} build, so voices and word timing cannot run there.`);
}

async function stageBinary(name, binaryName) {
  const pin = pins[name].targets[target];
  if (!pin) throw new Error(`No ${name} pinned for ${target} in desktop/runtime-binaries.json`);
  const dir = await unpack(pin.url, pin.sha256);
  copyExecutable(findFile(dir, exe(binaryName)), path.join(runtimeDir, 'bin', exe(binaryName)));
  const response = await fetch(pins[name].license);
  if (!response.ok) throw new Error(`Could not fetch the ${name} licence (${response.status})`);
  fs.mkdirSync(path.join(runtimeDir, 'licenses'), { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'licenses', `${name}-LICENSE.txt`), await response.text());
}

function stageFfmpeg(ffmpegDir) {
  const out = path.join(runtimeDir, 'ffmpeg');
  if (ffmpegDir) {
    fs.cpSync(ffmpegDir, out, { recursive: true });
    return;
  }
  run(process.execPath, [path.join(repoRoot, 'packaging', 'ffmpeg', 'fetch.mjs'), '--out', out], { shell: false });
}

function directorySize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += fs.statSync(path.join(entry.parentPath, entry.name)).size;
  }
  return total;
}

async function main() {
  const { ffmpegDir } = parseArgs(process.argv.slice(2));
  console.log(`[stage] ${target}, Node.js ${process.version}`);
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.rmSync(sourceStampFile, { force: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  const sourceTree = sourceTreeId(repoRoot);

  await stageNode();
  stageApp();
  stageDeployments();
  pruneOnnxRuntime();
  await stageBinary('nats', 'nats-server');
  await stageBinary('weed', 'weed');
  stageFfmpeg(ffmpegDir);
  if (sourceTree) fs.writeFileSync(sourceStampFile, `${sourceTree}\n`);

  for (const part of fs.readdirSync(runtimeDir)) {
    console.log(`[stage] ${part.padEnd(24)} ${(directorySize(path.join(runtimeDir, part)) / 1e6).toFixed(1)} MB`);
  }
}

main().catch((error) => {
  console.error(`[stage] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

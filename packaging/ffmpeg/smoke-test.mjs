#!/usr/bin/env node
// Verifies that an ffmpeg binary is licence-clean and can perform every operation
// OpenReader asks of it. The argument shapes mirror the callers:
//   packages/tts/src/audio-format.ts            stream transcode, CBR silence
//   packages/tts/src/probe.ts                   duration probe
//   packages/compute-worker/src/inference/whisper/align.ts   PCM decode
//   packages/compute-worker/src/jobs/playback/ffmpeg-export.ts  m4b and mp3 export
// Keep this list in step when a caller changes its ffmpeg arguments.
//
// Usage: node packaging/ffmpeg/smoke-test.mjs <path-to-ffmpeg>

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FORBIDDEN_CONFIGURE_FLAGS = ['--enable-gpl', '--enable-nonfree'];

function run(ffmpeg, args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', ...args], { encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function mustRun(ffmpeg, label, args) {
  const result = run(ffmpeg, args);
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status}):\n${result.stderr.slice(-1500)}`);
  }
  return result;
}

function assertNonEmpty(file, label) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`${label} produced no output`);
}

/** Throws unless the binary's configure line is free of GPL and nonfree options. */
export function assertLgplBuild(ffmpeg) {
  const { stdout, stderr } = mustRun(ffmpeg, 'buildconf', ['-buildconf']);
  const configuration = `${stdout}\n${stderr}`;
  const found = FORBIDDEN_CONFIGURE_FLAGS.filter((flag) => configuration.includes(flag));
  if (found.length > 0) throw new Error(`ffmpeg is not an LGPL build: configured with ${found.join(', ')}`);
}

/** Runs every operation OpenReader performs, in a scratch directory. */
export function exerciseOperations(ffmpeg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openreader-ffmpeg-smoke-'));
  const file = (name) => path.join(dir, name);
  try {
    // A provider's WAV response.
    mustRun(ffmpeg, 'generate wav', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=3', '-c:a', 'pcm_s16le', file('input.wav')]);

    // audio-format.ts: normalize to the stream profile, and the CBR silence second.
    mustRun(ffmpeg, 'stream transcode', ['-loglevel', 'error', '-y', '-i', file('input.wav'), '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '1', '-write_xing', '0', '-f', 'mp3', file('segment.mp3')]);
    assertNonEmpty(file('segment.mp3'), 'stream transcode');
    mustRun(ffmpeg, 'cbr silence', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '1', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '1', '-write_xing', '0', '-f', 'mp3', file('silence.mp3')]);
    assertNonEmpty(file('silence.mp3'), 'cbr silence');

    // probe.ts: ffmpeg -i <file> -f ffmetadata - (the duration is read from stderr).
    const probe = mustRun(ffmpeg, 'probe', ['-i', file('segment.mp3'), '-f', 'ffmetadata', '-']);
    if (!/Duration: \d{2}:\d{2}:\d{2}/.test(probe.stderr)) throw new Error('probe did not report a duration');

    // align.ts: decode to 16 kHz mono s16le for Whisper.
    mustRun(ffmpeg, 'whisper decode', ['-y', '-i', file('segment.mp3'), '-f', 's16le', '-ar', '16000', '-ac', '1', file('pcm.raw')]);
    assertNonEmpty(file('pcm.raw'), 'whisper decode');

    // ffmpeg-export.ts: m4b with chapters and a speed change, then mp3.
    fs.writeFileSync(file('chapters.txt'), ';FFMETADATA1\ntitle=Smoke\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1500\ntitle=One\n');
    mustRun(ffmpeg, 'm4b export', ['-loglevel', 'error', '-i', file('segment.mp3'), '-f', 'ffmetadata', '-i', file('chapters.txt'), '-filter:a', 'atempo=2,atempo=0.750000', '-vn', '-map', '0:a:0', '-codec:a', 'aac', '-b:a', '128k', '-map_metadata', '1', '-map_chapters', '1', '-f', 'mp4', '-brand', 'M4B ', '-movflags', '+faststart', file('book.m4b')]);
    assertNonEmpty(file('book.m4b'), 'm4b export');
    mustRun(ffmpeg, 'mp3 export', ['-loglevel', 'error', '-i', file('segment.mp3'), '-filter:a', 'atempo=1.250000', '-vn', '-codec:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', file('book.mp3')]);
    assertNonEmpty(file('book.mp3'), 'mp3 export');

    // Provider responses arrive as AAC in MP4/ADTS too; decode the export back.
    mustRun(ffmpeg, 'aac decode', ['-y', '-i', file('book.m4b'), '-f', 's16le', '-ar', '16000', '-ac', '1', file('aac.raw')]);
    assertNonEmpty(file('aac.raw'), 'aac decode');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function smokeTestFfmpeg(ffmpeg) {
  assertLgplBuild(ffmpeg);
  exerciseOperations(ffmpeg);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const ffmpeg = process.argv[2];
  if (!ffmpeg) {
    console.error('Usage: node packaging/ffmpeg/smoke-test.mjs <path-to-ffmpeg>');
    process.exit(2);
  }
  try {
    smokeTestFfmpeg(ffmpeg);
    console.log(`[ffmpeg] ${ffmpeg}: LGPL build, all OpenReader operations pass`);
  } catch (error) {
    console.error(`[ffmpeg] ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

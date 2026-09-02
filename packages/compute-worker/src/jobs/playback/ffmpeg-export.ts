import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { locatorGroupKey } from '@openreader/tts/locator';
import { normalizeLocator } from '@openreader/tts/segments';
import type { TTSSegmentLocator } from '@openreader/tts/types';
import { isHtmlLocator, isPdfLocator, isStableEpubLocator } from '@openreader/tts/types';
import type { TtsPlaybackSegmentInput } from './plan';

type ExportChapter = { title: string; startMs: number; endMs: number };

export function speedNeedsTranscode(speed: number): boolean {
  return Math.abs(speed - 1) >= 0.01;
}

function formatSpeedForFilename(speed: number): string {
  return Number.isInteger(speed) ? speed.toString() : speed.toFixed(1);
}

export function contentTypeForExportFormat(format: 'mp3' | 'm4b'): string {
  return format === 'm4b' ? 'audio/mp4' : 'audio/mpeg';
}

export function buildExportFilename(input: {
  documentId: string;
  speed: number;
  format: 'mp3' | 'm4b';
}): string {
  const speedSuffix = speedNeedsTranscode(input.speed) ? `-${formatSpeedForFilename(input.speed)}x` : '';
  return `openreader-${input.documentId.slice(0, 12)}${speedSuffix}.${input.format}`;
}

export function stripId3Tag(bytes: Buffer): Buffer {
  if (bytes.length < 10 || bytes.subarray(0, 3).toString('ascii') !== 'ID3') return bytes;
  const size = ((bytes[6] & 0x7f) << 21)
    | ((bytes[7] & 0x7f) << 14)
    | ((bytes[8] & 0x7f) << 7)
    | (bytes[9] & 0x7f);
  const end = 10 + size;
  return end > 0 && end < bytes.length ? bytes.subarray(end) : bytes;
}

function buildAtempoFilter(speed: number): string {
  const filters: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    filters.push('atempo=2');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(6)}`);
  return filters.join(',');
}

function escapeFfmetadataValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '').replace(/=/g, '\\=').replace(/;/g, '\\;').replace(/#/g, '\\#');
}

function fallbackChapterTitle(locator: TTSSegmentLocator | null, index: number): string {
  if (isPdfLocator(locator)) return `Page ${Math.max(1, Math.floor(locator.page))}`;
  if (isStableEpubLocator(locator)) return `Chapter ${index}`;
  if (isHtmlLocator(locator)) return index === 1 ? 'Document' : `Section ${index}`;
  return `Chapter ${index}`;
}

export function buildExportChapters(input: {
  segments: TtsPlaybackSegmentInput[];
  durationsByOrdinal: Map<number, number>;
  speed: number;
}): ExportChapter[] {
  const speed = Math.max(0.5, Math.min(3, Number.isFinite(input.speed) ? input.speed : 1));
  const chapters: ExportChapter[] = [];
  let activeGroup: string | null = null;
  let activeLocator: TTSSegmentLocator | null = null;
  let activeStartMs = 0;
  let cursorMs = 0;
  for (const segment of input.segments) {
    const locator = normalizeLocator(segment.locator as never);
    const group = locatorGroupKey(locator);
    if (activeGroup === null) {
      activeGroup = group;
      activeLocator = locator;
      activeStartMs = cursorMs;
    } else if (group !== activeGroup) {
      chapters.push({
        title: fallbackChapterTitle(activeLocator, chapters.length + 1),
        startMs: Math.max(0, Math.floor(activeStartMs / speed)),
        endMs: Math.max(0, Math.floor(cursorMs / speed)),
      });
      activeGroup = group;
      activeLocator = locator;
      activeStartMs = cursorMs;
    }
    cursorMs += Math.max(1, Math.floor(input.durationsByOrdinal.get(segment.ordinal) ?? 1000));
  }
  if (activeGroup !== null) {
    chapters.push({
      title: fallbackChapterTitle(activeLocator, chapters.length + 1),
      startMs: Math.max(0, Math.floor(activeStartMs / speed)),
      endMs: Math.max(0, Math.ceil(cursorMs / speed)),
    });
  }
  return chapters.map((chapter, index, all) => ({
    ...chapter,
    endMs: Math.max(chapter.startMs + 1, Math.min(chapter.endMs, all[index + 1]?.startMs ?? chapter.endMs)),
  })).filter((chapter) => chapter.endMs > chapter.startMs);
}

function buildFfmetadata(input: { title: string; chapters: ExportChapter[] }): string {
  const lines = [';FFMETADATA1', `title=${escapeFfmetadataValue(input.title)}`];
  for (const chapter of input.chapters) {
    lines.push(
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${Math.max(0, Math.floor(chapter.startMs))}`,
      `END=${Math.max(0, Math.floor(chapter.endMs))}`,
      `title=${escapeFfmetadataValue(chapter.title)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function runFfmpegExport(input: {
  source: Buffer;
  format: 'mp3' | 'm4b';
  speed: number;
  title: string;
  chapters: ExportChapter[];
}): Promise<Buffer> {
  const executable = ffmpegPath;
  if (!executable) throw new Error('ffmpeg-static did not provide an executable path');
  const workDir = await mkdtemp(join(tmpdir(), 'openreader-audiobook-export-'));
  const inputPath = join(workDir, 'input.mp3');
  const outputPath = join(workDir, input.format === 'm4b' ? 'audiobook.m4b' : 'audiobook.mp3');
  const metadataPath = join(workDir, 'chapters.ffmetadata');
  await writeFile(inputPath, input.source);
  const args = ['-hide_banner', '-loglevel', 'error', '-i', inputPath];
  if (input.format === 'm4b') {
    await writeFile(metadataPath, buildFfmetadata({ title: input.title, chapters: input.chapters }), 'utf8');
    args.push('-f', 'ffmetadata', '-i', metadataPath);
  }
  if (speedNeedsTranscode(input.speed)) args.push('-filter:a', buildAtempoFilter(input.speed));
  if (input.format === 'm4b') {
    args.push('-vn', '-map', '0:a:0', '-codec:a', 'aac', '-b:a', '128k', '-map_metadata', '1', '-map_chapters', '1', '-f', 'mp4', '-brand', 'M4B ', '-movflags', '+faststart', outputPath);
  } else {
    args.push('-vn', '-codec:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', outputPath);
  }
  try {
    const stderr: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(Buffer.from(chunk));
        if (stderr.length > 16) stderr.shift();
      });
      child.on('error', reject);
      child.on('close', (code: number | null) => {
        if (code) {
          reject(new Error(`ffmpeg audiobook export failed with code ${code}: ${Buffer.concat(stderr).toString('utf8').slice(-500)}`));
          return;
        }
        resolve();
      });
    });
    return await readFile(outputPath);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

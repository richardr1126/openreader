import { NextRequest, NextResponse } from 'next/server';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import ffmpegPath from 'ffmpeg-static';
import { createTtsPlaybackToken } from '@openreader/tts/playback-token';
import {
  isHtmlLocator,
  isPdfLocator,
  isStableEpubLocator,
} from '@openreader/tts/types';
import { locatorGroupKey } from '@openreader/tts/locator';
import {
  getComputeWorkerConfigFromEnv,
  isComputeWorkerAvailable,
} from '@/lib/server/compute-worker/client';
import {
  listCompletedTtsPlaybackSegments,
  resolveTtsPlaybackSession,
  type TtsPlaybackSessionRow,
} from '@/lib/server/tts/playback-sessions';
import {
  buildPlaybackGrid,
  readTtsPlaybackPlanArtifact,
  type TtsPlaybackGridSegment,
} from '@/lib/server/tts/playback-plans';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import type { TTSSegmentLocator } from '@/types/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type DownloadAudioFormat = 'mp3' | 'm4b';

type M4bChapter = {
  title: string;
  startMs: number;
  endMs: number;
};

function getPlaybackTokenSecret(): string {
  const secret = process.env.TTS_PLAYBACK_TOKEN_SECRET?.trim();
  if (!secret) throw new Error('TTS_PLAYBACK_TOKEN_SECRET is required for worker-owned playback');
  return secret;
}

function buildWorkerAudioUrl(input: {
  sessionId: string;
  userId: string;
  storageUserId: string;
  documentId: string;
  expiresAt: number;
}): string {
  const { baseUrl } = getComputeWorkerConfigFromEnv();
  const token = createTtsPlaybackToken({
    sessionId: input.sessionId,
    userId: input.userId,
    storageUserId: input.storageUserId,
    documentId: input.documentId,
    exp: input.expiresAt,
  }, getPlaybackTokenSecret());
  const url = new URL(`/v1/tts-playback/${encodeURIComponent(input.sessionId)}/audio`, baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

function readDownloadSpeed(request: NextRequest): number {
  const raw = request.nextUrl.searchParams.get('speed');
  if (!raw) return 1;
  const speed = Number(raw);
  if (!Number.isFinite(speed)) return 1;
  return Math.max(0.5, Math.min(3, speed));
}

function readDownloadFormat(request: NextRequest): DownloadAudioFormat {
  return request.nextUrl.searchParams.get('format') === 'm4b' ? 'm4b' : 'mp3';
}

function speedNeedsTranscode(speed: number): boolean {
  return Math.abs(speed - 1) >= 0.01;
}

function formatSpeedForFilename(speed: number): string {
  return Number.isInteger(speed) ? speed.toString() : speed.toFixed(1);
}

function formatNeedsTranscode(format: DownloadAudioFormat): boolean {
  return format === 'm4b';
}

function contentTypeForFormat(format: DownloadAudioFormat): string {
  return format === 'm4b' ? 'audio/mp4' : 'audio/mpeg';
}

function buildDownloadFilename(input: {
  documentId: string;
  speed: number;
  format: DownloadAudioFormat;
}): string {
  const speedSuffix = speedNeedsTranscode(input.speed) ? `-${formatSpeedForFilename(input.speed)}x` : '';
  return `openreader-${input.documentId.slice(0, 12)}${speedSuffix}.${input.format}`;
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
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/=/g, '\\=')
    .replace(/;/g, '\\;')
    .replace(/#/g, '\\#');
}

function fallbackChapterTitle(locator: TTSSegmentLocator | null, index: number): string {
  if (isPdfLocator(locator)) return `Page ${Math.max(1, Math.floor(locator.page))}`;
  if (isStableEpubLocator(locator)) return `Chapter ${index}`;
  if (isHtmlLocator(locator)) return index === 1 ? 'Document' : `Section ${index}`;
  return `Chapter ${index}`;
}

function buildM4bChaptersFromGrid(input: {
  segments: TtsPlaybackGridSegment[];
  durationMs: number;
  speed: number;
}): M4bChapter[] {
  const speed = Math.max(0.5, Math.min(3, Number.isFinite(input.speed) ? input.speed : 1));
  const chapters: M4bChapter[] = [];
  let activeGroup: string | null = null;
  let activeLocator: TTSSegmentLocator | null = null;
  let activeStartMs = 0;

  for (const segment of input.segments) {
    const group = locatorGroupKey(segment.locator);
    if (activeGroup === null) {
      activeGroup = group;
      activeLocator = segment.locator;
      activeStartMs = segment.startMs;
      continue;
    }
    if (group === activeGroup) continue;

    const chapterIndex = chapters.length + 1;
    chapters.push({
      title: fallbackChapterTitle(activeLocator, chapterIndex),
      startMs: Math.max(0, Math.floor(activeStartMs / speed)),
      endMs: Math.max(0, Math.floor(segment.startMs / speed)),
    });
    activeGroup = group;
    activeLocator = segment.locator;
    activeStartMs = segment.startMs;
  }

  if (activeGroup !== null) {
    const chapterIndex = chapters.length + 1;
    chapters.push({
      title: fallbackChapterTitle(activeLocator, chapterIndex),
      startMs: Math.max(0, Math.floor(activeStartMs / speed)),
      endMs: Math.max(0, Math.ceil(input.durationMs / speed)),
    });
  }

  return chapters
    .map((chapter, index, all) => ({
      ...chapter,
      endMs: Math.max(chapter.startMs + 1, Math.min(chapter.endMs, all[index + 1]?.startMs ?? chapter.endMs)),
    }))
    .filter((chapter) => chapter.endMs > chapter.startMs);
}

function buildFfmetadata(input: {
  title: string;
  chapters: M4bChapter[];
}): string {
  const lines = [
    ';FFMETADATA1',
    `title=${escapeFfmetadataValue(input.title)}`,
  ];
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

async function buildM4bChapters(input: {
  session: TtsPlaybackSessionRow;
  speed: number;
}): Promise<M4bChapter[]> {
  if (!input.session.planObjectKey) return [];
  const [plan, segments] = await Promise.all([
    readTtsPlaybackPlanArtifact(input.session.planObjectKey),
    listCompletedTtsPlaybackSegments(input.session, { limit: 10000 }),
  ]);
  const completedDurations = new Map(segments.map((segment) => [segment.ordinal, segment.durationMs]));
  const layout = buildPlaybackGrid({
    artifact: plan.artifact,
    settingsJson: input.session.settingsJson,
    completedDurations,
    startOrdinal: 0,
  });
  return buildM4bChaptersFromGrid({
    segments: layout.segments,
    durationMs: layout.durationMs,
    speed: input.speed,
  });
}

function pipeResponseStreamWithCleanup(source: Readable, cleanup: () => void): ReadableStream<Uint8Array> {
  let cleaned = false;
  const runCleanup = () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
  source.on('close', runCleanup);
  source.on('error', runCleanup);
  return Readable.toWeb(source) as ReadableStream<Uint8Array>;
}

function transcodeMp3Export(input: {
  body: ReadableStream<Uint8Array>;
  speed: number;
  signal: AbortSignal;
}): ReadableStream<Uint8Array> {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static did not provide an executable path');
  }

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
  ];

  if (speedNeedsTranscode(input.speed)) {
    args.push('-filter:a', buildAtempoFilter(input.speed));
  }

  args.push('-vn');
  args.push(
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '128k',
    '-f',
    'mp3',
    'pipe:1',
  );

  const ffmpeg = spawn(ffmpegPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const source = Readable.fromWeb(input.body as unknown as NodeReadableStream<Uint8Array>);
  const stderr: Buffer[] = [];

  const cleanup = () => {
    source.destroy();
    ffmpeg.stdin.destroy();
    if (!ffmpeg.killed) ffmpeg.kill('SIGKILL');
  };

  input.signal.addEventListener('abort', cleanup, { once: true });
  source.on('error', () => cleanup());
  ffmpeg.stdin.on('error', () => {});
  ffmpeg.stderr.on('data', (chunk) => {
    stderr.push(Buffer.from(chunk));
    if (stderr.length > 16) stderr.shift();
  });
  ffmpeg.on('error', (error) => {
    ffmpeg.stdout.destroy(error);
  });
  ffmpeg.on('close', (code) => {
    input.signal.removeEventListener('abort', cleanup);
    if (code && !input.signal.aborted) {
      const detail = Buffer.concat(stderr).toString('utf8').slice(-500);
      ffmpeg.stdout.destroy(new Error(`ffmpeg audiobook mp3 export failed with code ${code}: ${detail}`));
    }
  });

  source.pipe(ffmpeg.stdin);
  return Readable.toWeb(ffmpeg.stdout) as ReadableStream<Uint8Array>;
}

async function transcodeM4bExport(input: {
  body: ReadableStream<Uint8Array>;
  speed: number;
  title: string;
  chapters: M4bChapter[];
  signal: AbortSignal;
}): Promise<{
  body: ReadableStream<Uint8Array>;
  contentLength: number;
}> {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static did not provide an executable path');
  }

  const workDir = await mkdtemp(join(tmpdir(), 'openreader-audiobook-export-'));
  const outputPath = join(workDir, 'audiobook.m4b');
  const metadataPath = join(workDir, 'chapters.ffmetadata');
  await writeFile(metadataPath, buildFfmetadata({
    title: input.title,
    chapters: input.chapters,
  }), 'utf8');
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-f',
    'ffmetadata',
    '-i',
    metadataPath,
  ];

  if (speedNeedsTranscode(input.speed)) {
    args.push('-filter:a', buildAtempoFilter(input.speed));
  }

  args.push(
    '-vn',
    '-map',
    '0:a:0',
    '-codec:a',
    'aac',
    '-b:a',
    '128k',
    '-map_metadata',
    '1',
    '-map_chapters',
    '1',
    '-f',
    'mp4',
    '-brand',
    'M4B ',
    '-movflags',
    '+faststart',
    outputPath,
  );

  try {
    const ffmpeg = spawn(ffmpegPath, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const source = Readable.fromWeb(input.body as unknown as NodeReadableStream<Uint8Array>);
    const stderr: Buffer[] = [];

    const cleanupProcess = () => {
      source.destroy();
      ffmpeg.stdin.destroy();
      if (!ffmpeg.killed) ffmpeg.kill('SIGKILL');
    };

    const run = new Promise<void>((resolve, reject) => {
      input.signal.addEventListener('abort', cleanupProcess, { once: true });
      source.on('error', cleanupProcess);
      ffmpeg.stdin.on('error', () => {});
      ffmpeg.stderr.on('data', (chunk) => {
        stderr.push(Buffer.from(chunk));
        if (stderr.length > 16) stderr.shift();
      });
      ffmpeg.on('error', reject);
      ffmpeg.on('close', (code) => {
        input.signal.removeEventListener('abort', cleanupProcess);
        if (input.signal.aborted) {
          reject(new Error('M4B export was aborted'));
          return;
        }
        if (code) {
          const detail = Buffer.concat(stderr).toString('utf8').slice(-500);
          reject(new Error(`ffmpeg audiobook m4b export failed with code ${code}: ${detail}`));
          return;
        }
        resolve();
      });
    });

    source.pipe(ffmpeg.stdin);
    await run;

    const outputStat = await stat(outputPath);
    const fileStream = createReadStream(outputPath);
    return {
      body: pipeResponseStreamWithCleanup(fileStream, () => {
        void rm(workDir, { recursive: true, force: true });
      }),
      contentLength: outputStat.size,
    };
  } catch (error) {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string }> },
) {
  const { logger } = createRequestLogger({
    route: '/api/tts/stream/[sessionId]/audio',
    request,
  });
  try {
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json(
        { error: 'Compute worker is required for progressive TTS playback.' },
        { status: 503 },
      );
    }

    const { sessionId } = await context.params;
    const session = await resolveTtsPlaybackSession(request, sessionId);
    if (session instanceof Response) return session;
    const downloadSpeed = readDownloadSpeed(request);
    const downloadFormat = readDownloadFormat(request);
    const shouldTranscode = speedNeedsTranscode(downloadSpeed) || formatNeedsTranscode(downloadFormat);

    const upstream = await fetch(buildWorkerAudioUrl({
      sessionId: session.sessionId,
      userId: session.userId,
      storageUserId: session.storageUserId,
      documentId: session.documentId,
      expiresAt: session.expiresAt,
    }), {
      headers: {
        Accept: 'audio/mpeg',
        ...(!shouldTranscode && request.headers.get('range') ? { Range: request.headers.get('range') as string } : {}),
      },
      cache: 'no-store',
      signal: request.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      return NextResponse.json(
        { error: detail || 'Failed to proxy TTS playback audio' },
        { status: upstream.status || 502 },
      );
    }

    const headers = new Headers();
    for (const key of shouldTranscode
      ? ['content-type']
      : ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }
    headers.set('Content-Type', contentTypeForFormat(downloadFormat));
    headers.set('Cache-Control', 'private, no-store');
    headers.set(
      'Content-Disposition',
      `attachment; filename="${buildDownloadFilename({
        documentId: session.documentId,
        speed: downloadSpeed,
        format: downloadFormat,
      })}"`,
    );

    let body: ReadableStream<Uint8Array>;
    if (downloadFormat === 'm4b') {
      const chapters = await buildM4bChapters({
        session,
        speed: downloadSpeed,
      });
      const transcoded = await transcodeM4bExport({
        body: upstream.body,
        speed: downloadSpeed,
        title: `OpenReader ${session.documentId.slice(0, 12)}`,
        chapters,
        signal: request.signal,
      });
      headers.set('Content-Length', String(transcoded.contentLength));
      body = transcoded.body;
    } else if (shouldTranscode) {
      body = transcodeMp3Export({
        body: upstream.body,
        speed: downloadSpeed,
        signal: request.signal,
      });
    } else {
      body = upstream.body;
    }

    return new NextResponse(body, {
      status: shouldTranscode ? 200 : upstream.status,
      headers,
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.playback.audio_proxy_failed',
      msg: 'Failed to proxy TTS playback audio',
      apiErrorMessage: 'Failed to proxy TTS playback audio',
      normalize: { code: 'TTS_PLAYBACK_AUDIO_PROXY_FAILED', errorClass: 'upstream' },
    });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import ffmpegPath from 'ffmpeg-static';
import { createTtsPlaybackToken } from '@openreader/tts/playback-token';
import {
  getComputeWorkerConfigFromEnv,
  isComputeWorkerAvailable,
} from '@/lib/server/compute-worker/client';
import { resolveTtsPlaybackSession } from '@/lib/server/tts/playback-sessions';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

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

function speedNeedsTranscode(speed: number): boolean {
  return Math.abs(speed - 1) >= 0.01;
}

function formatSpeedForFilename(speed: number): string {
  return Number.isInteger(speed) ? speed.toString() : speed.toFixed(1);
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

function transcodeMp3Tempo(input: {
  body: ReadableStream<Uint8Array>;
  speed: number;
  signal: AbortSignal;
}): ReadableStream<Uint8Array> {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static did not provide an executable path');
  }

  const ffmpeg = spawn(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-filter:a',
    buildAtempoFilter(input.speed),
    '-vn',
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '128k',
    '-f',
    'mp3',
    'pipe:1',
  ], {
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
      ffmpeg.stdout.destroy(new Error(`ffmpeg audiobook tempo transform failed with code ${code}: ${detail}`));
    }
  });

  source.pipe(ffmpeg.stdin);
  return Readable.toWeb(ffmpeg.stdout) as ReadableStream<Uint8Array>;
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
    const shouldTranscode = speedNeedsTranscode(downloadSpeed);

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
    headers.set('Content-Type', 'audio/mpeg');
    headers.set('Cache-Control', 'private, no-store');
    headers.set(
      'Content-Disposition',
      shouldTranscode
        ? `attachment; filename="openreader-${session.documentId.slice(0, 12)}-${formatSpeedForFilename(downloadSpeed)}x.mp3"`
        : `attachment; filename="openreader-${session.documentId.slice(0, 12)}.mp3"`,
    );

    const body = shouldTranscode
      ? transcodeMp3Tempo({
        body: upstream.body,
        speed: downloadSpeed,
        signal: request.signal,
      })
      : upstream.body;

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

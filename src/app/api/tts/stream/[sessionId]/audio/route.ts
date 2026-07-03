import { NextRequest, NextResponse } from 'next/server';
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

type DownloadAudioFormat = 'mp3' | 'm4b';

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
  const url = new URL(`/v1/tts-playback/sessions/${encodeURIComponent(input.sessionId)}/audio`, baseUrl);
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

function formatSpeedForFilename(speed: number): string {
  return Number.isInteger(speed) ? speed.toString() : speed.toFixed(1);
}

function buildDownloadFilename(input: {
  documentId: string;
  speed: number;
  format: DownloadAudioFormat;
}): string {
  const speedSuffix = Math.abs(input.speed - 1) >= 0.01 ? `-${formatSpeedForFilename(input.speed)}x` : '';
  return `openreader-${input.documentId.slice(0, 12)}${speedSuffix}.${input.format}`;
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
    const unsupportedExport = downloadFormat !== 'mp3' || Math.abs(downloadSpeed - 1) >= 0.01;
    if (unsupportedExport) {
      return NextResponse.json(
        { error: 'Audiobook speed variants and M4B downloads are prepared by worker export artifacts.' },
        { status: 409 },
      );
    }

    const upstream = await fetch(buildWorkerAudioUrl({
      sessionId: session.sessionId,
      userId: session.userId,
      storageUserId: session.storageUserId,
      documentId: session.documentId,
      expiresAt: session.expiresAt,
    }), {
      headers: {
        Accept: 'audio/mpeg',
        ...(request.headers.get('range') ? { Range: request.headers.get('range') as string } : {}),
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
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }
    headers.set('Content-Type', 'audio/mpeg');
    headers.set('Cache-Control', 'private, no-store');
    headers.set(
      'Content-Disposition',
      `attachment; filename="${buildDownloadFilename({
        documentId: session.documentId,
        speed: downloadSpeed,
        format: downloadFormat,
      })}"`,
    );

    return new NextResponse(upstream.body, {
      status: upstream.status,
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

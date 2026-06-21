import { NextRequest, NextResponse } from 'next/server';
import { isS3Configured } from '@/lib/server/storage/s3';
import {
  buildSegmentAudioCacheHeaders,
  normalizeAudioByteRangeHeader,
  ttsSegmentsS3NotConfiguredResponse,
} from '@/lib/server/tts/segments-audio';
import { getTtsSegmentAudioObjectStream } from '@/lib/server/tts/segments-blobstore';
import {
  resolveCompletedTtsPlaybackSegment,
  resolveTtsPlaybackSession,
} from '@/lib/server/tts/playback-sessions';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ sessionId: string; ordinal: string }> },
) {
  const { logger } = createRequestLogger({
    route: '/api/tts/stream/[sessionId]/segment/[ordinal]',
    request,
  });
  try {
    if (!isS3Configured()) return ttsSegmentsS3NotConfiguredResponse();

    const { sessionId, ordinal: ordinalRaw } = await context.params;
    const ordinal = Number.parseInt(ordinalRaw, 10);
    if (!Number.isFinite(ordinal) || ordinal < 0) {
      return NextResponse.json({ error: 'Invalid segment ordinal' }, { status: 400 });
    }

    const session = await resolveTtsPlaybackSession(request, sessionId);
    if (session instanceof Response) return session;

    const segment = await resolveCompletedTtsPlaybackSegment(session, ordinal);
    if (!segment) return NextResponse.json({ error: 'Segment audio not found' }, { status: 404 });

    const range = normalizeAudioByteRangeHeader(request.headers.get('range'));
    if (request.headers.has('range') && !range) {
      return new NextResponse(null, {
        status: 416,
        headers: {
          ...buildSegmentAudioCacheHeaders(),
          'Accept-Ranges': 'bytes',
        },
      });
    }

    const audio = await getTtsSegmentAudioObjectStream(segment.audioKey, range ? { range } : undefined);
    const headers: Record<string, string> = {
      'Content-Type': audio.contentType || 'audio/mpeg',
      ...buildSegmentAudioCacheHeaders(),
      'Accept-Ranges': audio.acceptRanges || 'bytes',
    };
    if (audio.contentLength !== null) headers['Content-Length'] = String(audio.contentLength);
    if (audio.contentRange) headers['Content-Range'] = audio.contentRange;
    if (audio.etag) headers.ETag = audio.etag;
    if (audio.lastModified) headers['Last-Modified'] = audio.lastModified.toUTCString();

    return new NextResponse(audio.stream, {
      status: audio.statusCode || (range ? 206 : 200),
      headers,
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.playback.segment_failed',
      msg: 'Failed to load TTS playback segment',
      apiErrorMessage: 'Failed to load TTS playback segment',
      normalize: { code: 'TTS_PLAYBACK_SEGMENT_FAILED', errorClass: 'storage' },
    });
  }
}

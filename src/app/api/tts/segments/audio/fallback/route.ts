import { NextRequest, NextResponse } from 'next/server';
import { isS3Configured } from '@/lib/server/storage/s3';
import {
  buildSegmentAudioCacheHeaders,
  normalizeAudioByteRangeHeader,
  resolveCompletedSegmentAudio,
  ttsSegmentsS3NotConfiguredResponse,
} from '@/lib/server/tts/segments-audio';
import { getTtsSegmentAudioObjectStream } from '@/lib/server/tts/segments-blobstore';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { logger } = createRequestLogger({
    route: '/api/tts/segments/audio/fallback',
    request,
  });
  try {
    if (!isS3Configured()) return ttsSegmentsS3NotConfiguredResponse();

    const resolved = await resolveCompletedSegmentAudio(request);
    if (resolved instanceof Response) return resolved;

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

    const audio = await getTtsSegmentAudioObjectStream(resolved.audioKey, range ? { range } : undefined);
    const headers: Record<string, string> = {
      'Content-Type': audio.contentType || 'audio/mpeg',
      ...buildSegmentAudioCacheHeaders(),
      'Accept-Ranges': audio.acceptRanges || 'bytes',
    };
    if (audio.contentLength !== null) headers['Content-Length'] = String(audio.contentLength);
    if (audio.contentRange) headers['Content-Range'] = audio.contentRange;
    if (audio.etag) headers.ETag = audio.etag;
    if (audio.lastModified) headers['Last-Modified'] = audio.lastModified.toUTCString();

    const status = range ? 206 : 200;
    return new NextResponse(audio.stream, {
      status: audio.statusCode || status,
      headers,
    });
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.segments.audio_fallback_failed',
      msg: 'Failed to load segment audio from fallback route',
      apiErrorMessage: 'Failed to load segment audio',
      normalize: { code: 'TTS_SEGMENT_AUDIO_FALLBACK_FAILED', errorClass: 'storage' },
    });
  }
}

import { NextRequest, NextResponse } from 'next/server';
import { isS3Configured } from '@/lib/server/storage/s3';
import {
  buildSegmentAudioCacheHeaders,
  resolveCompletedSegmentAudio,
  ttsSegmentsS3NotConfiguredResponse,
} from '@/lib/server/tts/segments-audio';
import { presignTtsSegmentAudioGet } from '@/lib/server/tts/segments-blobstore';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    if (!isS3Configured()) return ttsSegmentsS3NotConfiguredResponse();

    const resolved = await resolveCompletedSegmentAudio(request);
    if (resolved instanceof Response) return resolved;

    const fallbackUrl = `/api/tts/segments/audio/fallback?documentId=${encodeURIComponent(resolved.documentId)}&segmentId=${encodeURIComponent(resolved.segmentId)}`;
    const directUrl = await presignTtsSegmentAudioGet(resolved.audioKey).catch(() => null);
    if (!directUrl) {
      console.warn('[blob-fallback] presign segment audio unavailable, redirecting to proxy fallback', {
        documentId: resolved.documentId,
        segmentId: resolved.segmentId,
      });
      return NextResponse.redirect(fallbackUrl, {
        status: 307,
        headers: buildSegmentAudioCacheHeaders('redirect'),
      });
    }

    return NextResponse.redirect(directUrl, {
      status: 307,
      headers: buildSegmentAudioCacheHeaders('redirect'),
    });
  } catch (error) {
    console.error('Error creating segment audio signature:', error);
    return NextResponse.json({ error: 'Failed to prepare segment audio' }, { status: 500 });
  }
}

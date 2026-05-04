import { NextRequest, NextResponse } from 'next/server';
import { isS3Configured } from '@/lib/server/storage/s3';
import {
  resolveCompletedSegmentAudio,
  streamAudioBuffer,
  ttsSegmentsS3NotConfiguredResponse,
} from '@/lib/server/tts/segments-audio';
import { getTtsSegmentAudioObject } from '@/lib/server/tts/segments-blobstore';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    if (!isS3Configured()) return ttsSegmentsS3NotConfiguredResponse();

    const resolved = await resolveCompletedSegmentAudio(request);
    if (resolved instanceof Response) return resolved;

    const audio = await getTtsSegmentAudioObject(resolved.audioKey);
    return new NextResponse(streamAudioBuffer(audio), {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('Error serving TTS segment audio fallback:', error);
    return NextResponse.json({ error: 'Failed to load segment audio' }, { status: 500 });
  }
}

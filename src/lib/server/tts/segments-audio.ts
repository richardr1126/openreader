import { and, eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '@/db';
import { ttsSegmentEntries, ttsSegmentVariants } from '@/db/schema';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';

export type ResolvedSegmentAudio = {
  documentId: string;
  segmentId: string;
  audioKey: string;
};

export const TTS_SEGMENT_REDIRECT_CACHE_CONTROL = 'private, max-age=60, stale-while-revalidate=30';
export const TTS_SEGMENT_FALLBACK_CACHE_CONTROL = 'private, max-age=300, stale-while-revalidate=60';
export const TTS_SEGMENT_AUDIO_VARY = 'Cookie, Authorization';

export function ttsSegmentsS3NotConfiguredResponse(): NextResponse {
  return NextResponse.json(
    { error: 'TTS segments storage is not configured. Set S3_* environment variables.' },
    { status: 503 },
  );
}

export function streamAudioBuffer(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

export function buildSegmentAudioCacheHeaders(kind: 'redirect' | 'fallback'): Record<string, string> {
  return {
    'Cache-Control': kind === 'redirect'
      ? TTS_SEGMENT_REDIRECT_CACHE_CONTROL
      : TTS_SEGMENT_FALLBACK_CACHE_CONTROL,
    Vary: TTS_SEGMENT_AUDIO_VARY,
  };
}

export async function resolveCompletedSegmentAudio(
  request: NextRequest,
): Promise<ResolvedSegmentAudio | Response> {
  const documentId = (request.nextUrl.searchParams.get('documentId') || '').trim().toLowerCase();
  const segmentId = (request.nextUrl.searchParams.get('segmentId') || '').trim().toLowerCase();
  if (!documentId || !segmentId) {
    return NextResponse.json({ error: 'Missing documentId or segmentId' }, { status: 400 });
  }

  const scope = await resolveSegmentDocumentScope(request, documentId);
  if (scope instanceof Response) return scope;

  const rows = (await db
    .select({
      audioKey: ttsSegmentVariants.audioKey,
      status: ttsSegmentVariants.status,
    })
    .from(ttsSegmentVariants)
    .innerJoin(ttsSegmentEntries, and(
      eq(ttsSegmentEntries.segmentEntryId, ttsSegmentVariants.segmentEntryId),
      eq(ttsSegmentEntries.userId, ttsSegmentVariants.userId),
    ))
    .where(and(
      eq(ttsSegmentVariants.userId, scope.storageUserId),
      eq(ttsSegmentEntries.documentId, documentId),
      eq(ttsSegmentEntries.documentVersion, scope.documentVersion),
      eq(ttsSegmentVariants.segmentId, segmentId),
    ))) as Array<{ audioKey: string | null; status: string }>;

  const row = rows[0];
  if (!row || !row.audioKey || row.status !== 'completed') {
    return NextResponse.json({ error: 'Segment audio not found' }, { status: 404 });
  }

  return { documentId, segmentId, audioKey: row.audioKey };
}

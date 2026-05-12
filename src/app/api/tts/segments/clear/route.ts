import { NextRequest, NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { ttsSegmentEntries, ttsSegmentVariants } from '@/db/schema';
import { deleteTtsSegmentAudioObjects } from '@/lib/server/tts/segments-blobstore';
import { resolveSegmentDocumentScope } from '@/lib/server/tts/segments-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseBody(value: unknown): { documentId: string } | null {
  if (!value || typeof value !== 'object') return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.documentId !== 'string' || !rec.documentId.trim()) return null;
  return { documentId: rec.documentId.trim().toLowerCase() };
}

export async function POST(request: NextRequest) {
  try {
    const parsed = parseBody(await request.json().catch(() => null));
    if (!parsed) {
      return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
    }

    const scope = await resolveSegmentDocumentScope(request, parsed.documentId);
    if (scope instanceof Response) return scope;

    const rows = (await db
      .select({
        segmentId: ttsSegmentVariants.segmentId,
        audioKey: ttsSegmentVariants.audioKey,
      })
      .from(ttsSegmentVariants)
      .innerJoin(ttsSegmentEntries, and(
        eq(ttsSegmentEntries.segmentEntryId, ttsSegmentVariants.segmentEntryId),
        eq(ttsSegmentEntries.userId, ttsSegmentVariants.userId),
      ))
      .where(and(
        eq(ttsSegmentEntries.userId, scope.storageUserId),
        eq(ttsSegmentEntries.documentId, parsed.documentId),
        eq(ttsSegmentEntries.documentVersion, scope.documentVersion),
      ))) as Array<{ segmentId: string; audioKey: string | null }>;

    await db
      .delete(ttsSegmentEntries)
      .where(and(
        eq(ttsSegmentEntries.userId, scope.storageUserId),
        eq(ttsSegmentEntries.documentId, parsed.documentId),
        eq(ttsSegmentEntries.documentVersion, scope.documentVersion),
      ));

    const audioKeys = rows
      .map((row) => row.audioKey)
      .filter((key): key is string => Boolean(key));
    const uniqueAudioKeys = Array.from(new Set(audioKeys));

    let deletedAudioObjects = 0;
    let warning: string | undefined;
    if (uniqueAudioKeys.length > 0) {
      try {
        deletedAudioObjects = await deleteTtsSegmentAudioObjects(uniqueAudioKeys);
        if (deletedAudioObjects < uniqueAudioKeys.length) {
          warning = `Deleted ${deletedAudioObjects} of ${uniqueAudioKeys.length} audio objects.`;
        }
      } catch (error) {
        warning = error instanceof Error ? error.message : 'Failed deleting some audio objects';
        console.warn('Failed clearing some TTS segment audio objects:', {
          documentId: parsed.documentId,
          userId: scope.storageUserId,
          error: warning,
        });
      }
    }

    return NextResponse.json({
      documentId: parsed.documentId,
      deletedSegments: rows.length,
      requestedAudioObjects: uniqueAudioKeys.length,
      deletedAudioObjects,
      ...(warning ? { warning } : {}),
    });
  } catch (error) {
    console.error('Error clearing TTS segment cache:', error);
    return NextResponse.json({ error: 'Failed to clear TTS segment cache' }, { status: 500 });
  }
}

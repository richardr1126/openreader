import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import { ttsSegmentEntries, ttsSegmentVariants } from '@/db/schema';
import { deleteTtsSegmentAudioObjects } from '@/lib/server/tts/segments-blobstore';
import type { ReaderType } from '@/types/user-state';
import { errorToLog, serverLogger } from '@/lib/server/logger';

type ClearTtsSegmentCacheInput = {
  userId: string;
  documentId: string;
  documentVersion?: number;
  readerType?: ReaderType;
};

export type ClearTtsSegmentCacheResult = {
  deletedSegments: number;
  requestedAudioObjects: number;
  deletedAudioObjects: number;
  warning?: string;
};

export async function clearTtsSegmentCache(
  input: ClearTtsSegmentCacheInput,
): Promise<ClearTtsSegmentCacheResult> {
  const conditions = [
    eq(ttsSegmentEntries.userId, input.userId),
    eq(ttsSegmentEntries.documentId, input.documentId),
  ];

  if (typeof input.documentVersion === 'number' && Number.isFinite(input.documentVersion)) {
    conditions.push(eq(ttsSegmentEntries.documentVersion, Math.floor(input.documentVersion)));
  }
  if (input.readerType) {
    conditions.push(eq(ttsSegmentEntries.readerType, input.readerType));
  }

  const rows = (await db
    .select({
      segmentId: ttsSegmentVariants.segmentId,
      audioKey: ttsSegmentVariants.audioKey,
    })
    .from(ttsSegmentVariants)
    .innerJoin(
      ttsSegmentEntries,
      and(
        eq(ttsSegmentEntries.segmentEntryId, ttsSegmentVariants.segmentEntryId),
        eq(ttsSegmentEntries.userId, ttsSegmentVariants.userId),
      ),
    )
    .where(and(...conditions))) as Array<{ segmentId: string; audioKey: string | null }>;

  await db.delete(ttsSegmentEntries).where(and(...conditions));

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
      serverLogger.warn({
        event: 'tts.segments.cache.audio_cleanup_failed',
        errorCode: 'TTS_SEGMENTS_CACHE_AUDIO_CLEANUP_FAILED',
        degraded: true,
        step: 'delete_tts_audio_objects',
        documentId: input.documentId,
        userId: input.userId,
        error: errorToLog(error),
      }, 'Failed clearing some TTS segment audio objects');
    }
  }

  return {
    deletedSegments: rows.length,
    requestedAudioObjects: uniqueAudioKeys.length,
    deletedAudioObjects,
    ...(warning ? { warning } : {}),
  };
}

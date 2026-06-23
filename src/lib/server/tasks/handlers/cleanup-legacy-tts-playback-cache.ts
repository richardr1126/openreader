import { count } from 'drizzle-orm';
import { db } from '@openreader/database';
import {
  ttsPlaybackSessions,
  ttsSegmentEntries,
  ttsSegmentVariants,
} from '@openreader/database/schema';
import { isS3Configured, getS3Config } from '@/lib/server/storage/s3';
import { deleteTtsSegmentPrefix } from '@/lib/server/tts/segments-blobstore';
import type { TaskContext, TaskResult } from '../types';

export async function cleanupLegacyTtsPlaybackCache(context: TaskContext): Promise<TaskResult> {
  context.signal.throwIfAborted();
  const [playbackSessionCount] = await db.select({ value: count() }).from(ttsPlaybackSessions);
  const [segmentEntryCount] = await db.select({ value: count() }).from(ttsSegmentEntries);
  const [segmentVariantCount] = await db.select({ value: count() }).from(ttsSegmentVariants);
  const before = {
    playbackSessions: Number(playbackSessionCount?.value ?? 0),
    segmentEntries: Number(segmentEntryCount?.value ?? 0),
    segmentVariants: Number(segmentVariantCount?.value ?? 0),
  };

  await db.delete(ttsSegmentVariants);
  context.signal.throwIfAborted();
  await db.delete(ttsSegmentEntries);
  context.signal.throwIfAborted();
  await db.delete(ttsPlaybackSessions);

  let deletedObjects = 0;
  if (isS3Configured()) {
    const prefix = getS3Config().prefix;
    for (const version of ['v1', 'v2'] as const) {
      context.signal.throwIfAborted();
      deletedObjects += await deleteTtsSegmentPrefix(`${prefix}/tts_segments_${version}/`);
    }
  }

  const deletedRows = before.playbackSessions + before.segmentEntries + before.segmentVariants;
  return {
    summary: `Deleted ${deletedRows} legacy TTS playback row(s) and ${deletedObjects} old audio object(s)`,
    deletedRows,
    deletedObjects,
    ...before,
  };
}

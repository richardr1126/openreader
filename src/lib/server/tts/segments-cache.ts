import { createHash } from 'crypto';
import {
  deleteTtsSegmentPrefix,
} from '@/lib/server/tts/segments-blobstore';
import { getS3Config } from '@/lib/server/storage/s3';
import type { ReaderType } from '@/types/user-state';
import {
  getComputeWorkerClient,
  isComputeWorkerAvailable,
} from '@/lib/server/compute-worker/client';

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
  deletedPlanObjects: number;
  deletedPlaybackObjects: number;
  invalidatedPlaybackSessions: number;
  warning?: string;
};

function storageUserHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}

async function deletePlaybackSegmentArtifactPrefixes(input: {
  userId: string;
  documentId: string;
  documentVersion?: number;
  readerType?: ReaderType;
  namespace?: string | null;
}): Promise<{
  deletedAudioObjects: number;
  deletedSidecarObjects: number;
  deletedPlanObjects: number;
}> {
  const cfg = getS3Config();
  const version = typeof input.documentVersion === 'number' && Number.isFinite(input.documentVersion)
    ? Math.floor(input.documentVersion)
    : null;
  const nsSegment = input.namespace ? `ns/${input.namespace}/` : '';
  const audioBase = `${cfg.prefix}/tts_playback_segments_audio_v1/${nsSegment}users/${encodeURIComponent(input.userId)}/docs/${input.documentId}/`;
  const sidecarBase = `${cfg.prefix}/tts_playback_segments_v1/users/${storageUserHash(input.userId)}/docs/${input.documentId}/`;
  const planBase = `${cfg.prefix}/tts_playback_plan_v1/${input.documentId}/`;
  const audioPrefix = version === null ? audioBase : `${audioBase}${version}/`;
  const sidecarPrefix = version === null ? sidecarBase : `${sidecarBase}${version}/`;
  const planPrefix = version === null
    ? planBase
    : input.readerType
      ? `${planBase}${version}/${input.readerType}/`
      : `${planBase}${version}/`;

  const deletedAudioObjects = await deleteTtsSegmentPrefix(audioPrefix);
  const deletedSidecarObjects = await deleteTtsSegmentPrefix(sidecarPrefix);
  const deletedPlanObjects = await deleteTtsSegmentPrefix(planPrefix);

  return {
    deletedAudioObjects,
    deletedSidecarObjects,
    deletedPlanObjects,
  };
}

export async function clearTtsSegmentCache(
  input: ClearTtsSegmentCacheInput,
): Promise<ClearTtsSegmentCacheResult> {
  let invalidatedPlaybackSessions = 0;
  let warning: string | undefined;

  if (isComputeWorkerAvailable()) {
    const reset = await getComputeWorkerClient().resetTtsPlaybackScope({
      storageUserId: input.userId,
      documentId: input.documentId,
      ...(typeof input.documentVersion === 'number' && Number.isFinite(input.documentVersion)
        ? { documentVersion: Math.max(0, Math.floor(input.documentVersion)) }
        : {}),
    });
    invalidatedPlaybackSessions = Math.max(0, Math.floor(Number(reset.invalidatedPlaybackSessions ?? 0)));
  } else {
    warning = 'Compute worker is not configured; active playback sessions were not invalidated.';
  }

  const deleted = await deletePlaybackSegmentArtifactPrefixes(input);
  const deletedAudioAndSidecarObjects = deleted.deletedAudioObjects + deleted.deletedSidecarObjects;
  const deletedPlaybackObjects = deletedAudioAndSidecarObjects + deleted.deletedPlanObjects;

  return {
    deletedSegments: 0,
    requestedAudioObjects: deletedAudioAndSidecarObjects,
    deletedAudioObjects: deletedAudioAndSidecarObjects,
    deletedPlanObjects: deleted.deletedPlanObjects,
    deletedPlaybackObjects,
    invalidatedPlaybackSessions,
    ...(warning ? { warning } : {}),
  };
}

export async function deleteDocumentTtsSegmentCache(input: {
  userId: string;
  documentId: string;
  namespace: string | null;
}): Promise<void> {
  await deletePlaybackSegmentArtifactPrefixes(input);
}

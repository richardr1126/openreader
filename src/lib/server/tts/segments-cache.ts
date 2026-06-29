import { createHash } from 'crypto';
import {
  deleteTtsSegmentPrefix,
} from '@/lib/server/tts/segments-blobstore';
import { buildTtsSegmentDocumentPrefix } from '@openreader/tts/segments';
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
  invalidatedPlaybackSessions: number;
  warning?: string;
};

function storageUserHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}

async function deletePlaybackSegmentArtifactPrefix(input: {
  userId: string;
  documentId: string;
  documentVersion?: number;
}): Promise<number> {
  const cfg = getS3Config();
  const base = `${cfg.prefix}/tts_playback_segments_v1/users/${storageUserHash(input.userId)}/docs/${input.documentId}/`;
  const prefix = typeof input.documentVersion === 'number' && Number.isFinite(input.documentVersion)
    ? `${base}${Math.floor(input.documentVersion)}/`
    : base;
  return deleteTtsSegmentPrefix(prefix);
}

export async function clearTtsSegmentCache(
  input: ClearTtsSegmentCacheInput,
): Promise<ClearTtsSegmentCacheResult> {
  const cfg = getS3Config();
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

  let deletedAudioObjects = 0;
  for (const storageVersion of ['v1', 'v2'] as const) {
    deletedAudioObjects += await deleteTtsSegmentPrefix(buildTtsSegmentDocumentPrefix({
      storagePrefix: cfg.prefix,
      namespace: null,
      userId: input.userId,
      documentId: input.documentId,
      storageVersion,
    }));
  }
  deletedAudioObjects += await deletePlaybackSegmentArtifactPrefix(input);

  return {
    deletedSegments: 0,
    requestedAudioObjects: deletedAudioObjects,
    deletedAudioObjects,
    invalidatedPlaybackSessions,
    ...(warning ? { warning } : {}),
  };
}

export async function deleteDocumentTtsSegmentCache(input: {
  userId: string;
  documentId: string;
  namespace: string | null;
}): Promise<void> {
  const cfg = getS3Config();
  for (const storageVersion of ['v1', 'v2'] as const) {
    await deleteTtsSegmentPrefix(buildTtsSegmentDocumentPrefix({
      storagePrefix: cfg.prefix,
      namespace: input.namespace,
      userId: input.userId,
      documentId: input.documentId,
      storageVersion,
    }));
  }
  await deletePlaybackSegmentArtifactPrefix(input);
}

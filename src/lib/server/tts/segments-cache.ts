import { createHash } from 'crypto';
import {
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import {
  deleteTtsSegmentPrefix,
} from '@/lib/server/tts/segments-blobstore';
import { getS3Config, getS3ProxyClient } from '@/lib/server/storage/s3';
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
  deletedExportObjects: number;
  invalidatedPlaybackSessions: number;
  invalidatedJobOperations: number;
  warning?: string;
};

function storageUserHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body === 'object' && body !== null && 'transformToByteArray' in body) {
    const maybe = body as { transformToByteArray?: () => Promise<Uint8Array> };
    if (typeof maybe.transformToByteArray === 'function') {
      return Buffer.from(await maybe.transformToByteArray());
    }
  }
  if (typeof body === 'object' && body !== null && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Unsupported S3 response body type');
}

async function deletePlaybackExportArtifactsForScope(input: {
  userId: string;
  documentId: string;
  documentVersion?: number;
}): Promise<number> {
  const cfg = getS3Config();
  const client = getS3ProxyClient();
  const rootPrefix = `${cfg.prefix}/tts_playback_exports_v1/`;
  const metadataKeys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const listRes = await client.send(new ListObjectsV2Command({
      Bucket: cfg.bucket,
      Prefix: rootPrefix,
      ContinuationToken: continuationToken,
    }));
    for (const item of listRes.Contents ?? []) {
      if (typeof item.Key === 'string' && item.Key.endsWith('/metadata.json')) {
        metadataKeys.push(item.Key);
      }
    }
    continuationToken = listRes.NextContinuationToken;
  } while (continuationToken);

  const prefixesToDelete = new Set<string>();
  for (const key of metadataKeys) {
    const response = await client.send(new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
    })).catch(() => null);
    if (!response?.Body) continue;
    const metadata = JSON.parse((await bodyToBuffer(response.Body)).toString('utf8')) as {
      storageUserId?: unknown;
      documentId?: unknown;
      documentVersion?: unknown;
    };
    if (metadata.storageUserId !== input.userId || metadata.documentId !== input.documentId) continue;
    const version = Number(metadata.documentVersion);
    if (
      typeof input.documentVersion === 'number'
      && Number.isFinite(input.documentVersion)
      && version !== Math.max(0, Math.floor(input.documentVersion))
    ) {
      continue;
    }
    prefixesToDelete.add(key.slice(0, key.length - 'metadata.json'.length));
  }

  let deleted = 0;
  for (const prefix of prefixesToDelete) {
    deleted += await deleteTtsSegmentPrefix(prefix);
  }
  return deleted;
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
  let invalidatedJobOperations = 0;
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
    invalidatedJobOperations = Math.max(0, Math.floor(Number(reset.invalidatedJobOperations ?? 0)));
  } else {
    warning = 'Compute worker is not configured; active playback sessions were not invalidated.';
  }

  const deleted = await deletePlaybackSegmentArtifactPrefixes(input);
  const deletedExportObjects = await deletePlaybackExportArtifactsForScope(input);
  const deletedAudioAndSidecarObjects = deleted.deletedAudioObjects + deleted.deletedSidecarObjects;
  const deletedPlaybackObjects = deletedAudioAndSidecarObjects + deleted.deletedPlanObjects + deletedExportObjects;

  return {
    deletedSegments: 0,
    requestedAudioObjects: deletedAudioAndSidecarObjects,
    deletedAudioObjects: deletedAudioAndSidecarObjects,
    deletedPlanObjects: deleted.deletedPlanObjects,
    deletedExportObjects,
    deletedPlaybackObjects,
    invalidatedPlaybackSessions,
    invalidatedJobOperations,
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

import { createHash } from 'node:crypto';
import type { ArtifactStorage } from '../infrastructure/storage';
import type { TtsPlaybackResetScope } from './storage';

export type TtsPlaybackCacheClearScope = TtsPlaybackResetScope & {
  namespace: string | null;
  readerType?: 'pdf' | 'epub' | 'html';
};

export type TtsPlaybackCacheClearResult = {
  deletedAudioObjects: number;
  deletedSidecarObjects: number;
  deletedPlanObjects: number;
  deletedExportObjects: number;
};

function storageUserHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}

async function deletePrefix(storage: ArtifactStorage, prefix: string): Promise<number> {
  const keys = await storage.listPrefix(prefix);
  for (let index = 0; index < keys.length; index += 32) {
    await Promise.all(keys.slice(index, index + 32).map((key) => storage.deleteObject(key)));
  }
  return keys.length;
}

export async function clearTtsPlaybackArtifacts(input: {
  storage: ArtifactStorage;
  s3Prefix: string;
  scope: TtsPlaybackCacheClearScope;
}): Promise<TtsPlaybackCacheClearResult> {
  const { storage, s3Prefix, scope } = input;
  const version = typeof scope.documentVersion === 'number' && Number.isFinite(scope.documentVersion)
    ? Math.max(0, Math.floor(scope.documentVersion))
    : null;
  const nsSegment = scope.namespace ? `ns/${scope.namespace}/` : '';
  const versionSegment = version === null ? '' : `${version}/`;
  const audioPrefix = `${s3Prefix}/tts_playback_segments_audio_v1/${nsSegment}users/${encodeURIComponent(scope.storageUserId)}/docs/${scope.documentId}/${versionSegment}`;
  const sidecarPrefix = `${s3Prefix}/tts_playback_segments_v1/users/${storageUserHash(scope.storageUserId)}/docs/${scope.documentId}/${versionSegment}`;
  const planPrefix = version === null
    ? `${s3Prefix}/tts_playback_plan_v1/${scope.documentId}/`
    : scope.readerType
      ? `${s3Prefix}/tts_playback_plan_v1/${scope.documentId}/${version}/${scope.readerType}/`
      : `${s3Prefix}/tts_playback_plan_v1/${scope.documentId}/${version}/`;

  const [deletedAudioObjects, deletedSidecarObjects, deletedPlanObjects] = await Promise.all([
    deletePrefix(storage, audioPrefix),
    deletePrefix(storage, sidecarPrefix),
    deletePrefix(storage, planPrefix),
  ]);

  const exportRoot = `${s3Prefix}/tts_playback_exports_v1/`;
  const exportMetadataKeys = (await storage.listPrefix(exportRoot)).filter((key) => key.endsWith('/metadata.json'));
  const exportPrefixes = new Set<string>();
  for (const key of exportMetadataKeys) {
    const metadata = await storage.readObject(key)
      .then((bytes) => JSON.parse(Buffer.from(bytes).toString('utf8')) as {
        storageUserId?: unknown;
        documentId?: unknown;
        documentVersion?: unknown;
      })
      .catch(() => null);
    if (!metadata || metadata.storageUserId !== scope.storageUserId || metadata.documentId !== scope.documentId) continue;
    if (version !== null && Number(metadata.documentVersion) !== version) continue;
    exportPrefixes.add(key.slice(0, -'metadata.json'.length));
  }
  const deletedExportObjects = (await Promise.all(
    [...exportPrefixes].map((prefix) => deletePrefix(storage, prefix)),
  )).reduce((total, count) => total + count, 0);

  return { deletedAudioObjects, deletedSidecarObjects, deletedPlanObjects, deletedExportObjects };
}

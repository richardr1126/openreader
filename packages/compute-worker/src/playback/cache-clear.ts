import type { ArtifactStorage } from '../infrastructure/storage';
import { ttsPlaybackExportArtifactScopePrefix } from '../storage/artifact-addressing';
import { deletePrefix, findExportArtifactPrefixesByMetadata, storageUserHash } from '../storage/prefix-cleanup';
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

  // Export artifacts are user/document-scoped, so the whole scope prefix can
  // be dropped directly; only a version-bounded clear needs metadata reads.
  const exportScopePrefix = ttsPlaybackExportArtifactScopePrefix({
    storageUserId: scope.storageUserId,
    documentId: scope.documentId,
    prefix: s3Prefix,
  });
  let deletedExportObjects: number;
  if (version === null) {
    deletedExportObjects = await deletePrefix(storage, exportScopePrefix);
  } else {
    const exportPrefixes = await findExportArtifactPrefixesByMetadata({
      storage,
      exportRoot: exportScopePrefix,
      ownsMetadata: (metadata) => Number(metadata.documentVersion) === version,
    });
    deletedExportObjects = (await Promise.all(
      exportPrefixes.map((prefix) => deletePrefix(storage, prefix)),
    )).reduce((total, count) => total + count, 0);
  }

  return { deletedAudioObjects, deletedSidecarObjects, deletedPlanObjects, deletedExportObjects };
}

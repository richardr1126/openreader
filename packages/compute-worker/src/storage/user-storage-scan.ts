// ONE-TIME (scan-orphaned-storage): lists the user-scoped storage written before
// document and account deletes queued their cleanup. Remove this file, its
// routes and schemas together with the app task.
import type { ArtifactStorage } from '../infrastructure/storage';
import { deletePrefix } from './prefix-cleanup';

export type UserStorageScopeRoot =
  | 'playback-audio'
  | 'playback-exports'
  | 'playback-sidecars'
  | 'account-exports'
  | 'cloned-voices';

const ROOTS: Record<UserStorageScopeRoot, { path: string; hasDocuments: boolean }> = {
  'playback-audio': { path: 'tts_playback_segments_audio_v1/users/', hasDocuments: true },
  'playback-exports': { path: 'tts_playback_exports_v1/users/', hasDocuments: true },
  'playback-sidecars': { path: 'tts_playback_segments_v1/users/', hasDocuments: true },
  'account-exports': { path: 'account_exports_v1/users/', hasDocuments: false },
  'cloned-voices': { path: 'cloned_voices_v1/users/', hasDocuments: false },
};

/**
 * One page of user folders under a root, with the document folders each holds.
 * Sidecar folders are named by the storage user hash rather than the user id.
 */
export async function listUserStorageScopes(input: {
  storage: ArtifactStorage;
  s3Prefix: string;
  root: UserStorageScopeRoot;
  startAfter: string | null;
  limit: number;
}): Promise<{
  users: Array<{ key: string; user: string; documentIds: string[] }>;
  nextStartAfter: string | null;
}> {
  const root = ROOTS[input.root];
  const rootPrefix = `${input.s3Prefix}/${root.path}`;
  const keys = await input.storage.listChildPrefixes(rootPrefix, {
    ...(input.startAfter ? { startAfter: input.startAfter } : {}),
    limit: input.limit,
  });
  const users = await Promise.all(keys.map(async (key) => ({
    key,
    user: input.root === 'playback-sidecars' ? key : decodeURIComponent(key),
    documentIds: root.hasDocuments
      ? await input.storage.listChildPrefixes(`${rootPrefix}${key}/docs/`)
      : [],
  })));
  return {
    users,
    nextStartAfter: keys.length === input.limit ? keys[keys.length - 1] : null,
  };
}

/** Delete every sidecar of a storage user hash that no longer maps to an account. */
export async function clearUserSidecarsByHash(input: {
  storage: ArtifactStorage;
  s3Prefix: string;
  storageUserHash: string;
}): Promise<number> {
  return deletePrefix(input.storage, `${input.s3Prefix}/${ROOTS['playback-sidecars'].path}${input.storageUserHash}/`);
}

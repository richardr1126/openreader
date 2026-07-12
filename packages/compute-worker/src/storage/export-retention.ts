import type { ArtifactStorage } from '../infrastructure/storage';
import { deletePrefix, findExportArtifactPrefixesByMetadata } from './prefix-cleanup';

export type ExportRetentionResult = {
  expiredArtifacts: number;
  deletedObjects: number;
};

/**
 * Delete export artifact directories (metadata + ZIP/audio + manifest) under
 * one export root whose metadata `createdAt` is past the retention window.
 * Metadata is only written when an artifact completes, so in-flight
 * preparations are never swept; a failed preparation leaves no artifact
 * directory to expire.
 */
export async function expireExportArtifactsUnderRoot(input: {
  storage: ArtifactStorage;
  exportRoot: string;
  maxAgeMs: number;
  now?: number;
}): Promise<ExportRetentionResult> {
  const cutoff = (input.now ?? Date.now()) - input.maxAgeMs;
  let expiredArtifacts = 0;
  let deletedObjects = 0;
  const expiredPrefixes = await findExportArtifactPrefixesByMetadata({
    storage: input.storage,
    exportRoot: input.exportRoot,
    ownsMetadata: (metadata) => typeof metadata.createdAt === 'number' && metadata.createdAt < cutoff,
  });
  for (const prefix of expiredPrefixes) {
    deletedObjects += await deletePrefix(input.storage, prefix);
    expiredArtifacts += 1;
  }
  return { expiredArtifacts, deletedObjects };
}

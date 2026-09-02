import { z } from 'zod';
import type { AccountExportArtifactMetadata, AccountExportJobRequest, AccountExportJobResult, AccountExportProgress } from '../operations/contracts';
import { accountExportArtifactKey, accountExportMetadataArtifactKey } from '../storage/artifact-addressing';
import { buildAccountExportArchive, type AccountExportManifest } from './account-export-archive';
import type { JobHandlerContext } from './context';

const requestSchema = z.object({
  artifactId: z.string().trim().regex(/^[a-f0-9]{8,128}$/i),
  userId: z.string().trim().min(1).max(256),
  storageUserId: z.string().trim().min(1).max(256),
  namespace: z.string().trim().min(1).max(128).nullable(),
  schemaVersion: z.number().int().positive(),
  manifestHash: z.string().trim().regex(/^[a-f0-9]{64}$/i),
  manifestObjectKey: z.string().trim().min(1).max(2048),
}).strict();

export function createAccountExportHandler(input: JobHandlerContext) {
  return async function runAccountExport(
    payload: AccountExportJobRequest,
    queueWaitMs: number,
    hooks?: { onProgress?: (progress: AccountExportProgress) => Promise<void> },
  ): Promise<AccountExportJobResult> {
    const parsed = requestSchema.parse(payload);
    const startedAt = Date.now();
    const metadataObjectKey = accountExportMetadataArtifactKey({ artifactId: parsed.artifactId, storageUserId: parsed.storageUserId, namespace: parsed.namespace, prefix: input.s3Prefix });
    const existingMetadata = await input.storage.readObject(metadataObjectKey)
      .then((bytes) => JSON.parse(Buffer.from(bytes).toString('utf8')) as AccountExportArtifactMetadata)
      .catch(() => null);
    if (
      existingMetadata?.schemaVersion === 1
      && existingMetadata.status === 'ready'
      && existingMetadata.userId === parsed.userId
      && existingMetadata.storageUserId === parsed.storageUserId
      && existingMetadata.namespace === parsed.namespace
      && existingMetadata.exportSchemaVersion === parsed.schemaVersion
      && existingMetadata.manifestHash === parsed.manifestHash
      && await input.storage.objectExists(existingMetadata.objectKey).catch(() => false)
    ) {
      return { artifact: existingMetadata, timing: { queueWaitMs, computeMs: Date.now() - startedAt } };
    }
    const manifest = JSON.parse(Buffer.from(await input.storage.readObject(parsed.manifestObjectKey)).toString('utf8')) as AccountExportManifest;
    if (manifest.userId !== parsed.userId || manifest.storageUserId !== parsed.storageUserId || manifest.namespace !== parsed.namespace || manifest.schemaVersion !== parsed.schemaVersion) {
      throw new Error('Account export manifest scope mismatch');
    }
    const archive = await buildAccountExportArchive({ manifest, readObject: input.storage.readObject, onProgress: hooks?.onProgress });
    const objectKey = accountExportArtifactKey({ artifactId: parsed.artifactId, storageUserId: parsed.storageUserId, namespace: parsed.namespace, prefix: input.s3Prefix });
    await input.storage.putObject(objectKey, archive, 'application/zip');
    const artifact: AccountExportArtifactMetadata = {
      schemaVersion: 1,
      artifactId: parsed.artifactId,
      userId: parsed.userId,
      storageUserId: parsed.storageUserId,
      namespace: parsed.namespace,
      exportSchemaVersion: parsed.schemaVersion,
      manifestHash: parsed.manifestHash,
      manifestObjectKey: parsed.manifestObjectKey,
      objectKey,
      contentType: 'application/zip',
      byteLength: archive.byteLength,
      dispositionFilename: `openreader-data-${parsed.storageUserId.slice(0, 8)}.zip`,
      status: 'ready',
      createdAt: Date.now(),
    };
    await input.storage.putObject(metadataObjectKey, Buffer.from(JSON.stringify(artifact)), 'application/json');
    await hooks?.onProgress?.({ phase: 'uploading', completedFiles: manifest.files.length, plannedFiles: manifest.files.length });
    return { artifact, timing: { queueWaitMs, computeMs: Date.now() - startedAt } };
  };
}

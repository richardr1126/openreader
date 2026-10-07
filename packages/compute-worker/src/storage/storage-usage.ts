import type { ArtifactStorage } from '../infrastructure/storage';
import {
  documentPreviewArtifactPrefix,
  parsedPdfArtifactPrefix,
  ttsPlaybackExportArtifactScopePrefix,
  ttsPlaybackPlanArtifactPrefix,
} from './artifact-addressing';
import { storageUserHash } from './prefix-cleanup';

/** Upper bound on objects one usage request lists, across every prefix it scans. */
export const STORAGE_USAGE_MAX_SCANNED_OBJECTS = 200_000;
const EXPORT_METADATA_READ_BATCH = 16;
const DERIVED_SCAN_CONCURRENCY = 8;

export type PlaybackVariantUsage = {
  documentVersion: number;
  settingsHash: string;
  bytes: number;
  objects: number;
};

export type PlaybackExportUsage = {
  /** Null when metadata was not read (library scans) or is unreadable. */
  documentVersion: number | null;
  settingsHash: string | null;
  bytes: number;
  objects: number;
};

export type DocumentStorageUsage = {
  documentId: string;
  /** Segment audio plus per-ordinal sidecars, grouped by cache identity. */
  variants: PlaybackVariantUsage[];
  exports: PlaybackExportUsage[];
  /** Shared, document-keyed derived artifacts: parsed layout, previews, plans. */
  derivedBytes: number;
  derivedObjects: number;
};

export type StorageUsageReport = {
  documents: DocumentStorageUsage[];
  scannedObjects: number;
  /** True when the scan stopped at the object budget; totals are a lower bound. */
  truncated: boolean;
};

type MutableDocumentUsage = {
  variants: Map<string, PlaybackVariantUsage>;
  exports: Map<string, PlaybackExportUsage & { metadataKey: string | null }>;
  derivedBytes: number;
  derivedObjects: number;
};

const DOCUMENT_ID_REGEX = /^[a-f0-9]{64}$/i;

/**
 * Aggregate a user's playback storage (and, optionally, the derived artifacts
 * of specific documents) by paging object listings. Memory stays proportional
 * to the number of documents and cache variants, never to the object count,
 * and the scan stops at `maxObjects` with `truncated: true`.
 *
 * Playback prefixes are the v5 user-scoped layout:
 *   audio:    tts_playback_segments_audio_v1/users/<userId>/docs/<doc>/<version>/<settingsHash>/<hash>.mp3
 *   sidecars: tts_playback_segments_v1/users/<userHash>/docs/<doc>/<version>/<settingsHash>/segments/<n>.json
 *   exports:  tts_playback_exports_v1/users/<userId>/docs/<doc>/<artifactId>/...
 * Segment audio is always written without a namespace segment.
 */
export async function collectStorageUsage(input: {
  storage: ArtifactStorage;
  s3Prefix: string;
  storageUserId: string;
  /** Scan playback audio, sidecars, and exports (default true). */
  includePlayback?: boolean;
  documentId?: string;
  /** Read export metadata so exports can be attributed to a cache variant. */
  attributeExports?: boolean;
  derivedDocumentIds?: string[];
  namespace?: string | null;
  maxObjects?: number;
}): Promise<StorageUsageReport> {
  const { storage, s3Prefix, storageUserId } = input;
  if (input.documentId !== undefined && !DOCUMENT_ID_REGEX.test(input.documentId)) {
    throw new Error(`Invalid document id: ${input.documentId}`);
  }
  const maxObjects = Math.max(1, input.maxObjects ?? STORAGE_USAGE_MAX_SCANNED_OBJECTS);
  const documents = new Map<string, MutableDocumentUsage>();
  const documentUsage = (documentId: string): MutableDocumentUsage => {
    let usage = documents.get(documentId);
    if (!usage) {
      usage = { variants: new Map(), exports: new Map(), derivedBytes: 0, derivedObjects: 0 };
      documents.set(documentId, usage);
    }
    return usage;
  };

  let scannedObjects = 0;
  let truncated = false;
  const scan = async (prefix: string, visit: (relativeKey: string, size: number) => void) => {
    if (truncated) return;
    for await (const page of storage.listPrefixPages(prefix)) {
      for (const object of page) {
        if (scannedObjects >= maxObjects) {
          truncated = true;
          return;
        }
        scannedObjects += 1;
        if (object.key.startsWith(prefix)) visit(object.key.slice(prefix.length), object.size);
      }
    }
  };

  const documentSegment = input.documentId ? `${input.documentId}/` : '';
  const addVariant = (relativeKey: string, size: number) => {
    const [documentId, version, settingsHash] = relativeKey.split('/');
    const documentVersion = Number(version);
    if (!documentId || !DOCUMENT_ID_REGEX.test(documentId) || !settingsHash || !Number.isSafeInteger(documentVersion)) {
      return;
    }
    const variants = documentUsage(documentId).variants;
    const variantKey = `${documentVersion}\0${settingsHash}`;
    const variant = variants.get(variantKey) ?? { documentVersion, settingsHash, bytes: 0, objects: 0 };
    variant.bytes += size;
    variant.objects += 1;
    variants.set(variantKey, variant);
  };

  if (input.includePlayback !== false) {
    const audioRoot = `${s3Prefix}/tts_playback_segments_audio_v1/users/${encodeURIComponent(storageUserId)}/docs/`;
    const sidecarRoot = `${s3Prefix}/tts_playback_segments_v1/users/${storageUserHash(storageUserId)}/docs/`;
    await scan(`${audioRoot}${documentSegment}`, (key, size) => addVariant(`${documentSegment}${key}`, size));
    await scan(`${sidecarRoot}${documentSegment}`, (key, size) => addVariant(`${documentSegment}${key}`, size));

    const exportRoot = `${ttsPlaybackExportArtifactScopePrefix({ storageUserId, prefix: s3Prefix })}docs/`;
    await scan(`${exportRoot}${documentSegment}`, (key, size) => {
      const [documentId, artifactId, file] = `${documentSegment}${key}`.split('/');
      if (!documentId || !DOCUMENT_ID_REGEX.test(documentId) || !artifactId || !file) return;
      const exports = documentUsage(documentId).exports;
      const usage = exports.get(artifactId)
        ?? { documentVersion: null, settingsHash: null, bytes: 0, objects: 0, metadataKey: null };
      usage.bytes += size;
      usage.objects += 1;
      if (file === 'metadata.json') usage.metadataKey = `${exportRoot}${documentId}/${artifactId}/metadata.json`;
      exports.set(artifactId, usage);
    });
  }

  if (input.attributeExports) {
    const exportRows = [...documents.values()].flatMap((usage) => [...usage.exports.values()])
      .filter((row) => row.metadataKey !== null);
    for (let index = 0; index < exportRows.length; index += EXPORT_METADATA_READ_BATCH) {
      await Promise.all(exportRows.slice(index, index + EXPORT_METADATA_READ_BATCH).map(async (row) => {
        const metadata = await storage.readObject(row.metadataKey!)
          .then((bytes) => JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>)
          .catch(() => null);
        const documentVersion = Number(metadata?.documentVersion);
        if (Number.isSafeInteger(documentVersion)) row.documentVersion = documentVersion;
        if (typeof metadata?.settingsHash === 'string' && metadata.settingsHash) row.settingsHash = metadata.settingsHash;
      }));
    }
  }

  const derivedPrefixes = [...new Set(input.derivedDocumentIds ?? [])]
    .filter((documentId) => DOCUMENT_ID_REGEX.test(documentId))
    .flatMap((documentId) => {
      const namespace = input.namespace ?? null;
      return [
        parsedPdfArtifactPrefix({ documentId, namespace, prefix: s3Prefix }),
        documentPreviewArtifactPrefix({ documentId, namespace, prefix: s3Prefix }),
        ttsPlaybackPlanArtifactPrefix({ documentId, prefix: s3Prefix }),
      ].map((prefix) => ({ documentId, prefix }));
    });
  // Derived prefixes are small, so batch the list calls instead of paying one
  // object-store round trip per prefix sequentially.
  for (let index = 0; index < derivedPrefixes.length && !truncated; index += DERIVED_SCAN_CONCURRENCY) {
    await Promise.all(derivedPrefixes.slice(index, index + DERIVED_SCAN_CONCURRENCY).map(({ documentId, prefix }) => {
      const usage = documentUsage(documentId);
      return scan(prefix, (_key, size) => {
        usage.derivedBytes += size;
        usage.derivedObjects += 1;
      });
    }));
  }

  return {
    documents: [...documents.entries()]
      .map(([documentId, usage]) => ({
        documentId,
        variants: [...usage.variants.values()]
          .sort((a, b) => a.documentVersion - b.documentVersion || a.settingsHash.localeCompare(b.settingsHash)),
        exports: [...usage.exports.values()].map(({ metadataKey: _metadataKey, ...row }) => row),
        derivedBytes: usage.derivedBytes,
        derivedObjects: usage.derivedObjects,
      }))
      .sort((a, b) => a.documentId.localeCompare(b.documentId)),
    scannedObjects,
    truncated,
  };
}

/**
 * The cache variants of one document that a reclaim should reset: every
 * (version, settings hash) found in segment storage or attributed export
 * metadata that does not match `keep`. `keep: null` reclaims everything.
 */
export function reclaimableVariants(
  usage: DocumentStorageUsage | undefined,
  keep: { documentVersion: number; settingsHash?: string } | null,
): Array<{ documentVersion: number; settingsHash: string }> {
  if (!usage) return [];
  const kept = (documentVersion: number, settingsHash: string) => keep !== null
    && documentVersion === keep.documentVersion
    && (keep.settingsHash === undefined || settingsHash === keep.settingsHash);
  const variants = new Map<string, { documentVersion: number; settingsHash: string }>();
  const consider = (documentVersion: number | null, settingsHash: string | null) => {
    if (documentVersion === null || settingsHash === null || kept(documentVersion, settingsHash)) return;
    variants.set(`${documentVersion}\0${settingsHash}`, { documentVersion, settingsHash });
  };
  for (const variant of usage.variants) consider(variant.documentVersion, variant.settingsHash);
  for (const row of usage.exports) consider(row.documentVersion, row.settingsHash);
  return [...variants.values()];
}

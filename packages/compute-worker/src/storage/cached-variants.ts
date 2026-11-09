import { STREAM_AUDIO_BYTES_PER_SECOND } from '@openreader/tts/audio-format';
import type { ArtifactStorage } from '../infrastructure/storage';
import { storageUserHash } from './prefix-cleanup';

export type CachedPlaybackVariant = {
  settingsHash: string;
  settingsJson: unknown;
  segments: number;
  durationMs: number;
  updatedAt: number;
};

const VARIANT_LIMIT = 50;

/**
 * The speech settings this document has audio for, in this version. Segment
 * audio is constant-bitrate, so its size gives its length without a probe; the
 * settings come from one segment's record, since every record in a variant shares them.
 */
export async function listCachedPlaybackVariants(input: {
  storage: ArtifactStorage;
  s3Prefix: string;
  storageUserId: string;
  documentId: string;
  documentVersion: number;
}): Promise<CachedPlaybackVariant[]> {
  const { storage, s3Prefix, storageUserId, documentId } = input;
  const version = Math.max(0, Math.floor(input.documentVersion));
  const audioRoot = `${s3Prefix}/tts_playback_segments_audio_v1/users/${encodeURIComponent(storageUserId)}/docs/${documentId}/${version}/`;
  const sidecarRoot = `${s3Prefix}/tts_playback_segments_v1/users/${storageUserHash(storageUserId)}/docs/${documentId}/${version}/`;
  const hashes = await storage.listChildPrefixes(audioRoot, { limit: VARIANT_LIMIT });
  const variants: CachedPlaybackVariant[] = [];
  for (const hash of hashes) {
    const settingsHash = hash.replace(/\/$/, '');
    let segments = 0;
    let bytes = 0;
    let updatedAt = 0;
    for await (const page of storage.listPrefixPages(`${audioRoot}${settingsHash}/`)) {
      for (const object of page) {
        segments += 1;
        bytes += object.size;
        updatedAt = Math.max(updatedAt, object.lastModifiedMs);
      }
    }
    if (segments === 0) continue;
    const settingsJson = await readVariantSettings(storage, `${sidecarRoot}${settingsHash}/segments/`);
    if (settingsJson === null) continue;
    variants.push({
      settingsHash,
      settingsJson,
      segments,
      durationMs: Math.round((bytes / STREAM_AUDIO_BYTES_PER_SECOND) * 1000),
      updatedAt,
    });
  }
  return variants.sort((left, right) => right.updatedAt - left.updatedAt);
}

async function readVariantSettings(storage: ArtifactStorage, prefix: string): Promise<unknown> {
  for await (const page of storage.listPrefixPages(prefix)) {
    for (const object of page.slice(0, 5)) {
      try {
        const record = JSON.parse(Buffer.from(await storage.readObject(object.key)).toString('utf8')) as { settingsJson?: unknown };
        const settings = typeof record.settingsJson === 'string' ? JSON.parse(record.settingsJson) : record.settingsJson;
        if (settings && typeof settings === 'object') return settings;
      } catch {
        // A record being rewritten is skipped; the next one carries the same settings.
      }
    }
    return null;
  }
  return null;
}

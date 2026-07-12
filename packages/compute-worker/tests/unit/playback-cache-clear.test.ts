import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { clearTtsPlaybackArtifacts } from '../../src/playback/cache-clear';
import type { ArtifactStorage } from '../../src/infrastructure/storage';

class MemoryStorage implements ArtifactStorage {
  readonly objects = new Map<string, Buffer>();

  async readObject(key: string): Promise<ArrayBuffer> {
    const value = this.objects.get(key);
    if (!value) throw new Error('not found');
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }

  async objectExists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async listPrefix(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  async putObject(key: string, body: Buffer | Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }

  async putParsedPdf(): Promise<string> {
    throw new Error('not implemented');
  }
}

describe('playback cache clear', () => {
  test('deletes only the requested playback scope and matching export artifacts', async () => {
    const storage = new MemoryStorage();
    const prefix = 'openreader-test';
    const documentId = 'a'.repeat(64);
    const foreignDocumentId = 'b'.repeat(64);
    const userHash = createHash('sha256').update('user-1').digest('hex');
    await storage.putObject(`${prefix}/tts_playback_segments_audio_v1/users/user-1/docs/${documentId}/3/settings/audio.mp3`, Buffer.from('audio'));
    await storage.putObject(`${prefix}/tts_playback_segments_v1/users/${userHash}/docs/${documentId}/3/settings/segments/0.json`, Buffer.from('{}'));
    await storage.putObject(`${prefix}/tts_playback_plan_v1/${documentId}/3/pdf/plan.json`, Buffer.from('{}'));
    const exportScope = `${prefix}/tts_playback_exports_v1/users/user-1/docs/${documentId}`;
    await storage.putObject(`${exportScope}/export-a/metadata.json`, Buffer.from(JSON.stringify({
      storageUserId: 'user-1', documentId, documentVersion: 3,
    })));
    await storage.putObject(`${exportScope}/export-a/artifact.mp3`, Buffer.from('export'));
    await storage.putObject(`${exportScope}/export-old/metadata.json`, Buffer.from(JSON.stringify({
      storageUserId: 'user-1', documentId, documentVersion: 2,
    })));
    await storage.putObject(`${prefix}/tts_playback_exports_v1/users/user-1/docs/${foreignDocumentId}/export-b/metadata.json`, Buffer.from(JSON.stringify({
      storageUserId: 'user-1', documentId: foreignDocumentId, documentVersion: 3,
    })));

    const result = await clearTtsPlaybackArtifacts({
      storage,
      s3Prefix: prefix,
      scope: { storageUserId: 'user-1', documentId, documentVersion: 3, readerType: 'pdf', namespace: null },
    });

    expect(result).toEqual({
      deletedAudioObjects: 1,
      deletedSidecarObjects: 1,
      deletedPlanObjects: 1,
      deletedExportObjects: 2,
    });
    expect(storage.objects.has(`${exportScope}/export-a/artifact.mp3`)).toBe(false);
    expect(storage.objects.has(`${exportScope}/export-old/metadata.json`)).toBe(true);
    expect(storage.objects.has(`${prefix}/tts_playback_exports_v1/users/user-1/docs/${foreignDocumentId}/export-b/metadata.json`)).toBe(true);
  });
});

import { describe, expect, test } from 'vitest';
import type { ArtifactStorage } from '../../src/infrastructure/storage';
import {
  clearDocumentPreviewArtifacts,
  clearPdfLayoutArtifacts,
  clearTtsPlaybackPlanArtifacts,
} from '../../src/storage/document-derived-cleanup';

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

describe('document derived-artifact cleanup', () => {
  test('deletes the current parsed, preview, and playback-plan prefixes for one document', async () => {
    const storage = new MemoryStorage();
    const prefix = 'openreader-test';
    const namespace = 'test-scope';
    const documentId = 'a'.repeat(64);
    const otherDocumentId = 'b'.repeat(64);
    const ownedKeys = [
      `${prefix}/documents_v1/parsed_v2/ns/${namespace}/${documentId}/parser.json`,
      `${prefix}/document_previews_v1/ns/${namespace}/${documentId}/card-400.jpg`,
      `${prefix}/document_previews_v1/ns/${namespace}/${documentId}/metadata.json`,
      `${prefix}/tts_playback_plan_v1/${documentId}/1/pdf/plan.json`,
    ];
    const retainedKeys = [
      `${prefix}/documents_v1/ns/${namespace}/${documentId}`,
      `${prefix}/documents_v1/parsed_v2/ns/${namespace}/${otherDocumentId}/parser.json`,
      `${prefix}/document_previews_v1/ns/${namespace}/${otherDocumentId}/card-400.jpg`,
      `${prefix}/tts_playback_plan_v1/${otherDocumentId}/1/pdf/plan.json`,
    ];
    for (const key of [...ownedKeys, ...retainedKeys]) {
      await storage.putObject(key, Buffer.from('data'));
    }

    await expect(clearPdfLayoutArtifacts({
      storage,
      s3Prefix: prefix,
      documentId,
      namespace,
    })).resolves.toBe(1);
    await expect(clearDocumentPreviewArtifacts({
      storage,
      s3Prefix: prefix,
      documentId,
      namespace,
    })).resolves.toBe(2);
    await expect(clearTtsPlaybackPlanArtifacts({
      storage,
      s3Prefix: prefix,
      documentId,
    })).resolves.toBe(1);
    expect([...storage.objects.keys()].sort()).toEqual(retainedKeys.sort());
  });
});

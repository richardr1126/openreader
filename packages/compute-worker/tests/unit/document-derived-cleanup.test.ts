import { describe, expect, test } from 'vitest';
import { MemoryArtifactStorage as MemoryStorage } from '../fixtures/memory-storage';
import {
  clearDocumentPreviewArtifacts,
  clearPdfLayoutArtifacts,
  clearTtsPlaybackPlanArtifacts,
} from '../../src/storage/document-derived-cleanup';

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

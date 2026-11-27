import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { buildTtsPlaybackSettingsHash, type SegmentationSignatureInput } from '@openreader/tts/segments';
import type { TTSSegmentSettings } from '@openreader/tts/types';
import type { ArtifactStorage } from '../../src/infrastructure/storage';
import { clearTtsPlaybackArtifacts } from '../../src/playback/cache-clear';
import { collectStorageUsage, reclaimableVariants } from '../../src/storage/storage-usage';
import { listMemoryChildPrefixes } from '../fixtures/memory-storage';

const PREFIX = 'test';
const USER = 'user-1';
const DOCUMENT_ID = 'a'.repeat(64);
const VERSION = 7;
const REVISION = 'c'.repeat(32);

/** Memory storage whose deletions can be held while other writes land. */
class GatedStorage implements ArtifactStorage {
  readonly objects = new Map<string, Buffer>();
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  deleting = 0;

  holdDeletes() {
    this.gate = new Promise((resolve) => { this.release = resolve; });
  }

  releaseDeletes() {
    this.release?.();
    this.gate = null;
  }

  async readObject(key: string): Promise<ArrayBuffer> {
    const value = this.objects.get(key);
    if (!value) throw Object.assign(new Error(`missing ${key}`), { name: 'NoSuchKey' });
    return Uint8Array.from(value).buffer;
  }

  async objectExists(key: string) { return this.objects.has(key); }

  async deleteObject(key: string) {
    this.deleting += 1;
    await this.gate;
    this.deleting -= 1;
    this.objects.delete(key);
  }

  async listPrefix(prefix: string) { return [...this.objects.keys()].filter((key) => key.startsWith(prefix)); }

  async *listPrefixPages(prefix: string) {
    yield [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, size: value.byteLength, lastModifiedMs: 0 }));
  }

  async listChildPrefixes(prefix: string, options?: { startAfter?: string; limit?: number }) {
    return listMemoryChildPrefixes(this.objects.keys(), prefix, options);
  }

  async putObject(key: string, body: Buffer | Uint8Array) { this.objects.set(key, Buffer.from(body)); }
  async putFile(): Promise<void> { throw new Error('unused'); }
  async putParsedPdf(): Promise<string> { throw new Error('unused'); }
}

const voice: TTSSegmentSettings = {
  providerRef: 'kokoro', providerType: 'custom-openai', ttsModel: 'kokoro', voice: 'af_alloy', nativeSpeed: 1, language: 'en',
};
const segmentation: SegmentationSignatureInput = {
  maxBlockLength: null, language: 'en', enforceSourceBoundaries: true, skipBlockKinds: ['header', 'footer'], isPlainText: false, namespace: null,
};
const hashOf = (settings: Partial<TTSSegmentSettings> = {}, fields: Partial<SegmentationSignatureInput> = {}) => (
  buildTtsPlaybackSettingsHash({ ...voice, ...settings }, { ...segmentation, ...fields }));

const legacy = hashOf();
const reparsed = hashOf({}, { narrationRevision: REVISION });
const otherVoice = hashOf({ voice: 'af_heart' });
const otherVoiceReparsed = hashOf({ voice: 'af_heart' }, { narrationRevision: REVISION });
const otherSkips = hashOf({}, { skipBlockKinds: ['header'], narrationRevision: REVISION });

const userHash = createHash('sha256').update(USER).digest('hex');
async function seedVariant(storage: GatedStorage, settingsHash: string, version = VERSION, exportId?: string) {
  const variant = `docs/${DOCUMENT_ID}/${version}/${settingsHash}`;
  await storage.putObject(`${PREFIX}/tts_playback_segments_audio_v1/users/${USER}/${variant}/0.mp3`, Buffer.alloc(100));
  await storage.putObject(`${PREFIX}/tts_playback_segments_v1/users/${userHash}/${variant}/segments/0.json`, Buffer.alloc(5));
  if (exportId) {
    const dir = `${PREFIX}/tts_playback_exports_v1/users/${USER}/docs/${DOCUMENT_ID}/${exportId}`;
    await storage.putObject(`${dir}/metadata.json`, Buffer.from(JSON.stringify({ documentVersion: version, settingsHash })));
    await storage.putObject(`${dir}/artifact.mp3`, Buffer.alloc(200));
  }
}

const variantsIn = (storage: GatedStorage) => new Set([...storage.objects.keys()]
  .filter((key) => key.includes('/tts_playback_segments_audio_v1/'))
  .map((key) => key.split('/').slice(-3, -1).join('/')));
const exportsIn = (storage: GatedStorage) => new Set([...storage.objects.keys()]
  .filter((key) => key.includes('/tts_playback_exports_v1/') && key.endsWith('/artifact.mp3'))
  .map((key) => key.split('/').at(-2)));

/** The worker's document reclaim: list, select and clear each unused variant. */
async function reclaim(storage: GatedStorage, keepSettingsHash: string, whileDeleting?: () => Promise<void>) {
  const usage = await collectStorageUsage({
    storage, s3Prefix: PREFIX, storageUserId: USER, documentId: DOCUMENT_ID, attributeExports: true,
  });
  const variants = reclaimableVariants(usage.documents[0], { documentVersion: VERSION, settingsHash: keepSettingsHash });
  if (whileDeleting) storage.holdDeletes();
  const clearing = Promise.all(variants.map((variant) => clearTtsPlaybackArtifacts({
    storage,
    s3Prefix: PREFIX,
    scope: { storageUserId: USER, documentId: DOCUMENT_ID, ...variant, namespace: null },
  })));
  if (whileDeleting) {
    await new Promise((resolve) => setImmediate(resolve));
    expect(storage.deleting).toBeGreaterThan(0);
    await whileDeleting();
    storage.releaseDeletes();
  }
  await clearing;
  return variants;
}

describe('PDF reclaim after Force reparse', () => {
  test('a changed reparse keeps the settings part of the audio identity and adds the revision', () => {
    expect(reparsed).toBe(`${legacy}.${REVISION}`);
    expect(legacy).toMatch(/^[a-f0-9]{64}$/);
  });

  test('audio and exports with the current settings on every layout stay, and other settings and uploads are reclaimed', async () => {
    const storage = new GatedStorage();
    await seedVariant(storage, legacy, VERSION, 'export-legacy');
    await seedVariant(storage, reparsed, VERSION, 'export-reparsed');
    await seedVariant(storage, otherVoice, VERSION, 'export-other-voice');
    await seedVariant(storage, otherVoiceReparsed);
    await seedVariant(storage, otherSkips);
    await seedVariant(storage, legacy, VERSION - 1, 'export-older-upload');

    const reclaimed = await reclaim(storage, reparsed);

    expect(reclaimed).toHaveLength(4);
    expect(variantsIn(storage)).toEqual(new Set([`${VERSION}/${legacy}`, `${VERSION}/${reparsed}`]));
    expect(exportsIn(storage)).toEqual(new Set(['export-legacy', 'export-reparsed']));
    // The same reclaim before any reparse keeps the same set.
    await seedVariant(storage, otherVoice, VERSION, 'export-other-voice');
    await reclaim(storage, legacy);
    expect(variantsIn(storage)).toEqual(new Set([`${VERSION}/${legacy}`, `${VERSION}/${reparsed}`]));
  });

  test('a reparse that finishes during cleanup keeps the audiobook made on its new layout', async () => {
    const storage = new GatedStorage();
    await seedVariant(storage, legacy);
    await seedVariant(storage, otherVoice);
    // Reclaim was asked for while the layout had no revision yet. The reparse
    // finished and the new layout's first audio exists before the worker lists
    // storage; its audiobook is published while the deletions run.
    await seedVariant(storage, reparsed);

    await reclaim(storage, legacy, async () => {
      await seedVariant(storage, reparsed, VERSION, 'export-new-layout');
    });

    expect(variantsIn(storage)).toEqual(new Set([`${VERSION}/${legacy}`, `${VERSION}/${reparsed}`]));
    expect(exportsIn(storage)).toEqual(new Set(['export-new-layout']));
  });

  test('an export published from the earlier layout while cleanup runs keeps its files', async () => {
    const storage = new GatedStorage();
    await seedVariant(storage, legacy);
    await seedVariant(storage, reparsed);
    await seedVariant(storage, otherVoiceReparsed, VERSION, 'export-other-voice');

    // A reader that still holds the pre-reparse plan publishes after the listing.
    await reclaim(storage, reparsed, async () => {
      await seedVariant(storage, legacy, VERSION, 'export-earlier-layout');
    });

    expect(variantsIn(storage)).toEqual(new Set([`${VERSION}/${legacy}`, `${VERSION}/${reparsed}`]));
    expect(exportsIn(storage)).toEqual(new Set(['export-earlier-layout']));
  });
});

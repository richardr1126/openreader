import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { collectStorageUsage, reclaimableVariants } from '../../src/storage/storage-usage';
import type { ArtifactStorage } from '../../src/infrastructure/storage';

class MemoryStorage implements ArtifactStorage {
  readonly objects = new Map<string, Buffer>();
  listedPages = 0;

  constructor(private readonly pageSize = 2) {}

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

  async *listPrefixPages(prefix: string) {
    const matches = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, size: value.byteLength }));
    for (let index = 0; index < matches.length; index += this.pageSize) {
      this.listedPages += 1;
      yield matches.slice(index, index + this.pageSize);
    }
  }

  async putObject(key: string, body: Buffer | Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }

  async putParsedPdf(): Promise<string> {
    throw new Error('not implemented');
  }
}

const prefix = 'openreader-test';
const user = 'user-1';
const userHash = createHash('sha256').update(user).digest('hex');
const docA = 'a'.repeat(64);
const docB = 'b'.repeat(64);

async function seed(storage: MemoryStorage) {
  const audio = (doc: string, version: number, hash: string, name: string, bytes: number) => storage.putObject(
    `${prefix}/tts_playback_segments_audio_v1/users/${user}/docs/${doc}/${version}/${hash}/${name}.mp3`,
    Buffer.alloc(bytes),
  );
  const sidecar = (doc: string, version: number, hash: string, ordinal: number, bytes: number) => storage.putObject(
    `${prefix}/tts_playback_segments_v1/users/${userHash}/docs/${doc}/${version}/${hash}/segments/${ordinal}.json`,
    Buffer.alloc(bytes),
  );
  await audio(docA, 3, 'current', 'one', 100);
  await audio(docA, 3, 'current', 'two', 50);
  await sidecar(docA, 3, 'current', 0, 5);
  await audio(docA, 3, 'othervoice', 'one', 70);
  await sidecar(docA, 3, 'othervoice', 0, 5);
  await audio(docA, 2, 'current', 'old', 30);
  await audio(docB, 1, 'current', 'one', 40);
  // Another user's audio must never be counted.
  await storage.putObject(`${prefix}/tts_playback_segments_audio_v1/users/user-2/docs/${docA}/3/current/x.mp3`, Buffer.alloc(999));
  const exportDir = `${prefix}/tts_playback_exports_v1/users/${user}/docs/${docA}/export-1`;
  await storage.putObject(`${exportDir}/metadata.json`, Buffer.from(JSON.stringify({
    documentVersion: 3,
    settingsHash: 'othervoice',
  })));
  await storage.putObject(`${exportDir}/artifact.mp3`, Buffer.alloc(200));
  await storage.putObject(`${prefix}/documents_v1/parsed_v2/${docA}/v1.json`, Buffer.alloc(11));
  await storage.putObject(`${prefix}/document_previews_v1/ns/_default/${docA}/card-400.jpg`, Buffer.alloc(13));
  await storage.putObject(`${prefix}/tts_playback_plan_v1/${docA}/3/pdf/plan.json`, Buffer.alloc(17));
}

describe('storage usage', () => {
  test('groups one document by cache variant and attributes exports from metadata', async () => {
    const storage = new MemoryStorage();
    await seed(storage);

    const report = await collectStorageUsage({
      storage,
      s3Prefix: prefix,
      storageUserId: user,
      documentId: docA,
      attributeExports: true,
      derivedDocumentIds: [docA],
    });

    expect(report.truncated).toBe(false);
    expect(report.documents).toHaveLength(1);
    const [usage] = report.documents;
    expect(usage.documentId).toBe(docA);
    expect(usage.variants).toEqual([
      { documentVersion: 2, settingsHash: 'current', bytes: 30, objects: 1 },
      { documentVersion: 3, settingsHash: 'current', bytes: 155, objects: 3 },
      { documentVersion: 3, settingsHash: 'othervoice', bytes: 75, objects: 2 },
    ]);
    expect(usage.exports).toEqual([{
      documentVersion: 3,
      settingsHash: 'othervoice',
      bytes: 200 + Buffer.byteLength(JSON.stringify({ documentVersion: 3, settingsHash: 'othervoice' })),
      objects: 2,
    }]);
    expect(usage.derivedBytes).toBe(11 + 13 + 17);
    expect(usage.derivedObjects).toBe(3);
  });

  test('scans a whole library without reading export metadata', async () => {
    const storage = new MemoryStorage();
    await seed(storage);

    const report = await collectStorageUsage({ storage, s3Prefix: prefix, storageUserId: user });

    expect(report.documents.map((row) => row.documentId)).toEqual([docA, docB]);
    expect(report.documents[0].exports[0]).toMatchObject({ documentVersion: null, settingsHash: null });
    expect(report.documents[1].variants).toEqual([
      { documentVersion: 1, settingsHash: 'current', bytes: 40, objects: 1 },
    ]);
  });

  test('measures only derived artifacts when playback scanning is skipped', async () => {
    const storage = new MemoryStorage();
    await seed(storage);

    const report = await collectStorageUsage({
      storage,
      s3Prefix: prefix,
      storageUserId: user,
      includePlayback: false,
      derivedDocumentIds: [docA],
    });

    expect(report.documents).toEqual([{
      documentId: docA, variants: [], exports: [], derivedBytes: 11 + 13 + 17, derivedObjects: 3,
    }]);
  });

  test('stops at the object budget and reports a truncated lower bound', async () => {
    const storage = new MemoryStorage(1);
    await seed(storage);

    const report = await collectStorageUsage({ storage, s3Prefix: prefix, storageUserId: user, maxObjects: 3 });

    expect(report.truncated).toBe(true);
    expect(report.scannedObjects).toBe(3);
    expect(storage.listedPages).toBeLessThanOrEqual(4);
  });

  test('selects every variant except the kept cache identity', async () => {
    const storage = new MemoryStorage();
    await seed(storage);
    const [usage] = (await collectStorageUsage({
      storage,
      s3Prefix: prefix,
      storageUserId: user,
      documentId: docA,
      attributeExports: true,
    })).documents;

    expect(reclaimableVariants(usage, { documentVersion: 3, settingsHash: 'current' })).toEqual([
      { documentVersion: 2, settingsHash: 'current' },
      { documentVersion: 3, settingsHash: 'othervoice' },
    ]);
    expect(reclaimableVariants(usage, { documentVersion: 3 })).toEqual([
      { documentVersion: 2, settingsHash: 'current' },
    ]);
    expect(reclaimableVariants(usage, null)).toHaveLength(3);
    expect(reclaimableVariants(undefined, null)).toEqual([]);
  });
});

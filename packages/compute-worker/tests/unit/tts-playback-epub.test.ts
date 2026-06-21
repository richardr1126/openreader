import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { resolvePlaybackSourceUnits } from '../../src/jobs/handlers';
import { extractEpubSpine } from '../../src/inference/epub/spine-text';
import { documentSourceKey } from '../../src/storage/artifact-addressing';

const PREFIX = 'openreader';
const DOCUMENT_ID = 'e'.repeat(64);
const SAMPLE = path.resolve(process.cwd(), 'tests/files/sample.epub');
const hasSample = existsSync(SAMPLE);
const epubBytes = hasSample ? readFileSync(SAMPLE) : Buffer.alloc(0);

function fakeStorage() {
  const key = documentSourceKey({ documentId: DOCUMENT_ID, namespace: null, prefix: PREFIX });
  return {
    key,
    readObject: async (requested: string): Promise<ArrayBuffer> => {
      if (requested !== key) throw new Error(`unexpected key: ${requested}`);
      return epubBytes.buffer.slice(epubBytes.byteOffset, epubBytes.byteOffset + epubBytes.byteLength) as ArrayBuffer;
    },
  };
}

function epubRequest(documentSource: Record<string, unknown>) {
  return {
    sessionId: 'session-epub',
    userId: 'user-1',
    storageUserId: 'user-1',
    documentId: DOCUMENT_ID,
    documentVersion: 1,
    readerType: 'epub' as const,
    settingsHash: 'hash',
    settingsJson: { voice: 'alloy', providerRef: 'p', providerType: 'openai', ttsModel: 'm', nativeSpeed: 1 },
    startOrdinal: 0,
    planning: { documentSource },
  } as Parameters<typeof resolvePlaybackSourceUnits>[0];
}

describe.runIf(hasSample)('worker-owned EPUB spine extraction + derivation', () => {
  test('extracts spine items in order with clean body text (no markup, no head leakage)', async () => {
    const spine = await extractEpubSpine(epubBytes);
    expect(spine.length).toBeGreaterThan(1);
    // Spine indices are 0-based and strictly increasing in order.
    expect(spine.map((s) => s.index)).toEqual(spine.map((_, i) => i).slice(0, spine.length));
    const withText = spine.filter((s) => s.text.trim().length > 0);
    expect(withText.length).toBeGreaterThan(0);
    for (const item of withText) {
      expect(item.href).toBeTruthy();
      // body.textContent never contains raw tag markup.
      expect(item.text).not.toMatch(/<[a-z/!]/i);
    }
  });

  test('document extent derives one epub source unit per non-empty spine item', async () => {
    const storage = fakeStorage();
    const units = await resolvePlaybackSourceUnits(
      epubRequest({ namespace: null, extent: 'document', startSpineIndex: 0 }),
      storage,
      PREFIX,
    );
    expect(units.length).toBeGreaterThan(0);
    for (const unit of units) {
      expect(unit.sourceKey).toMatch(/^spine:\d+:/);
      expect(unit.locator).toMatchObject({ readerType: 'epub', charOffset: 0 });
      expect(unit.text.trim().length).toBeGreaterThan(0);
    }
  });

  test('section extent derives only the requested spine item', async () => {
    const spine = await extractEpubSpine(epubBytes);
    const target = spine.find((s) => s.text.trim().length > 0)!;
    const storage = fakeStorage();
    const units = await resolvePlaybackSourceUnits(
      epubRequest({ namespace: null, extent: 'section', startSpineIndex: target.index }),
      storage,
      PREFIX,
    );
    expect(units).toHaveLength(1);
    expect(units[0].sourceKey).toBe(`spine:${target.index}:${target.href}`);
  });
});

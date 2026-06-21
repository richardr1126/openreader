import { describe, expect, test } from 'vitest';
import { parseTtsSettings, resolvePlaybackSourceUnits } from '../../src/jobs/handlers';
import { documentSourceKey } from '../../src/storage/artifact-addressing';
import { buildHtmlDocumentText, parseHtmlBlocks } from '@openreader/tts/html-blocks';

const PREFIX = 'openreader';
const DOCUMENT_ID = 'c'.repeat(64);

const MARKDOWN = `# Title

First paragraph with **bold** and a [link](https://example.com).

- item one
- item two
`;

function fakeStorage(source: string) {
  const key = documentSourceKey({ documentId: DOCUMENT_ID, namespace: null, prefix: PREFIX });
  const body = Buffer.from(source, 'utf8');
  return {
    key,
    readObject: async (requested: string): Promise<ArrayBuffer> => {
      if (requested !== key) throw new Error(`unexpected key: ${requested}`);
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    },
  };
}

function htmlRequest(documentSource: Record<string, unknown>) {
  return {
    sessionId: 'session-html',
    userId: 'user-1',
    storageUserId: 'user-1',
    documentId: DOCUMENT_ID,
    documentVersion: 1,
    readerType: 'html' as const,
    settingsHash: 'hash',
    settingsJson: { voice: 'alloy', providerRef: 'p', providerType: 'openai', ttsModel: 'm', nativeSpeed: 1 },
    startOrdinal: 0,
    planning: { documentSource },
  } as Parameters<typeof resolvePlaybackSourceUnits>[0];
}

describe('worker-owned HTML/TXT/MD playback derivation', () => {
  test('accepts legacy canonical SQLite settings JSON', () => {
    const settings = parseTtsSettings(JSON.stringify({
      providerRef: 'supertonic',
      providerType: 'custom-openai',
      model: 'sonic',
      voice: 'narrator',
      speed: 1,
      instructions: 'calm',
      language: 'en-US',
      format: 'mp3',
    }));

    expect(settings).toMatchObject({
      providerRef: 'supertonic',
      providerType: 'custom-openai',
      ttsModel: 'sonic',
      voice: 'narrator',
      nativeSpeed: 1,
      ttsInstructions: 'calm',
      language: 'en-US',
    });
  });

  test('derives a single full-document source unit with html location', async () => {
    const storage = fakeStorage(MARKDOWN);
    const units = await resolvePlaybackSourceUnits(
      htmlRequest({ namespace: null, extent: 'document', isPlainText: false }),
      storage,
      PREFIX,
    );
    expect(units).toHaveLength(1);
    expect(units[0].sourceKey).toBe('1');
    expect(units[0].locator).toEqual({ readerType: 'html', location: '1' });
  });

  test('worker text matches the shared parser output byte-for-byte (markdown stripped)', async () => {
    const storage = fakeStorage(MARKDOWN);
    const [unit] = await resolvePlaybackSourceUnits(
      htmlRequest({ namespace: null, extent: 'document', isPlainText: false }),
      storage,
      PREFIX,
    );
    const expected = buildHtmlDocumentText(parseHtmlBlocks(MARKDOWN, false));
    expect(unit.text).toBe(expected);
    // markdown markers are stripped; visible link label is kept.
    expect(unit.text).toContain('bold');
    expect(unit.text).toContain('link');
    expect(unit.text).not.toContain('**');
    expect(unit.text).not.toContain('](https');
  });

  test('plain-text mode splits on blank lines without markdown processing', async () => {
    const storage = fakeStorage('Line with **stars** kept.\n\nSecond paragraph.');
    const [unit] = await resolvePlaybackSourceUnits(
      htmlRequest({ namespace: null, extent: 'section', isPlainText: true }),
      storage,
      PREFIX,
    );
    // In txt mode the asterisks are literal text, not markdown emphasis.
    expect(unit.text).toContain('**stars**');
  });
});

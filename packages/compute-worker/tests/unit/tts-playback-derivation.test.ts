import { describe, expect, test } from 'vitest';
import { planTtsPlaybackSegments, resolvePlaybackSourceUnits } from '../../src/jobs/handlers';
import { parsedPdfArtifactKey } from '../../src/storage/artifact-addressing';

const PREFIX = 'openreader';
const DOCUMENT_ID = 'a'.repeat(64);

function parsedPdfArtifact() {
  const page = (pageNumber: number, blocks: Array<{ id: string; kind: string; text: string }>) => ({
    pageNumber,
    width: 100,
    height: 100,
    blocks: blocks.map((block, index) => ({
      id: block.id,
      kind: block.kind,
      text: block.text,
      fragments: [{ page: pageNumber, bbox: [0, 0, 1, 1], text: block.text, readingOrder: index }],
    })),
  });
  return {
    schemaVersion: 1,
    documentId: DOCUMENT_ID,
    parserVersion: 'test',
    parsedAt: 0,
    pages: [
      page(1, [{ id: 'b1', kind: 'text', text: 'Page one body.' }]),
      page(2, [
        { id: 'b2', kind: 'header', text: 'Running header' },
        { id: 'b3', kind: 'text', text: 'Page two body.' },
      ]),
      page(3, [{ id: 'b4', kind: 'text', text: 'Page three body.' }]),
    ],
  };
}

function fakeStorage() {
  const key = parsedPdfArtifactKey({ documentId: DOCUMENT_ID, namespace: null, prefix: PREFIX });
  const body = Buffer.from(JSON.stringify(parsedPdfArtifact()));
  return {
    key,
    readObject: async (requested: string): Promise<ArrayBuffer> => {
      if (requested !== key) throw new Error(`unexpected key: ${requested}`);
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    },
  };
}

function baseRequest(planning: Record<string, unknown>) {
  return {
    sessionId: 'session-1',
    userId: 'user-1',
    storageUserId: 'user-1',
    documentId: DOCUMENT_ID,
    documentVersion: 1,
    readerType: 'pdf' as const,
    settingsHash: 'hash',
    settingsJson: { voice: 'alloy', providerRef: 'p', providerType: 'openai', ttsModel: 'm', nativeSpeed: 1 },
    startOrdinal: 0,
    planning,
  } as Parameters<typeof resolvePlaybackSourceUnits>[0];
}

describe('worker-owned TTS playback source derivation', () => {
  test('legacy path returns client-provided source units verbatim', async () => {
    const storage = fakeStorage();
    const units = await resolvePlaybackSourceUnits(
      baseRequest({
        sourceUnits: [{ sourceKey: 'k', text: 'hi', locator: { readerType: 'pdf', page: 1 } }],
      }),
      storage,
      PREFIX,
    );
    expect(units).toEqual([{ sourceKey: 'k', text: 'hi', locator: { readerType: 'pdf', page: 1 } }]);
  });

  test('document extent derives all pages from the parsed artifact, skipping headers', async () => {
    const storage = fakeStorage();
    const units = await resolvePlaybackSourceUnits(
      baseRequest({ documentSource: { namespace: null, skipBlockKinds: ['header'], extent: 'document', startPage: 1 } }),
      storage,
      PREFIX,
    );
    expect(units.map((u) => u.sourceKey)).toEqual([
      `pdf:1:b1`,
      `pdf:2:b3`,
      `pdf:3:b4`,
    ]);
  });

  test('section extent derives only the start page', async () => {
    const storage = fakeStorage();
    const units = await resolvePlaybackSourceUnits(
      baseRequest({ documentSource: { namespace: null, extent: 'section', startPage: 2 } }),
      storage,
      PREFIX,
    );
    expect(units.map((u) => u.sourceKey)).toEqual([`pdf:2:b2`, `pdf:2:b3`]);
  });

  test('document extent starting mid-document only includes pages at or after start', async () => {
    const storage = fakeStorage();
    const units = await resolvePlaybackSourceUnits(
      baseRequest({ documentSource: { namespace: null, skipBlockKinds: ['header'], extent: 'document', startPage: 2 } }),
      storage,
      PREFIX,
    );
    expect(units.map((u) => u.sourceKey)).toEqual([`pdf:2:b3`, `pdf:3:b4`]);
  });

  test('planned playback segment indexes use canonical global ordinals across source units', () => {
    const segments = planTtsPlaybackSegments(
      baseRequest({ enforceSourceBoundaries: true }),
      [
        { sourceKey: 'pdf:1:b1', text: 'First PDF block.', locator: { readerType: 'pdf', page: 1, blockId: 'b1' } },
        { sourceKey: 'pdf:1:b2', text: 'Second PDF block.', locator: { readerType: 'pdf', page: 1, blockId: 'b2' } },
        { sourceKey: 'pdf:1:b3', text: 'Third PDF block.', locator: { readerType: 'pdf', page: 1, blockId: 'b3' } },
      ],
    );
    expect(segments.map((segment) => segment.segmentIndex)).toEqual([0, 1, 2]);
  });
});

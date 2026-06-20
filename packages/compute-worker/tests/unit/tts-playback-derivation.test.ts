import { describe, expect, test } from 'vitest';
import {
  computePlaybackPlanSignature,
  planTtsPlaybackSegments,
  resolvePlaybackSourceUnits,
  resolvePlaybackStartOrdinal,
} from '../../src/jobs/handlers';
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

  test('derivation returns the whole document, skipping headers', async () => {
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

  test('derivation is position-independent: same whole-document units regardless of start page or extent', async () => {
    const storage = fakeStorage();
    const fromTop = await resolvePlaybackSourceUnits(
      baseRequest({ documentSource: { namespace: null, skipBlockKinds: ['header'], extent: 'document', startPage: 1 } }),
      storage,
      PREFIX,
    );
    const fromMid = await resolvePlaybackSourceUnits(
      baseRequest({ documentSource: { namespace: null, skipBlockKinds: ['header'], extent: 'section', startPage: 2 } }),
      storage,
      PREFIX,
    );
    expect(fromMid.map((u) => u.sourceKey)).toEqual(fromTop.map((u) => u.sourceKey));
    expect(fromMid.map((u) => u.sourceKey)).toEqual([`pdf:1:b1`, `pdf:2:b3`, `pdf:3:b4`]);
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

  function wholeDocPlan() {
    return planTtsPlaybackSegments(
      baseRequest({ enforceSourceBoundaries: true }),
      [
        { sourceKey: 'pdf:1:b1', text: 'First block.', locator: { readerType: 'pdf', page: 1, blockId: 'b1' } },
        { sourceKey: 'pdf:2:b2', text: 'Second block.', locator: { readerType: 'pdf', page: 2, blockId: 'b2' } },
        { sourceKey: 'pdf:3:b3', text: 'Third block.', locator: { readerType: 'pdf', page: 3, blockId: 'b3' } },
      ],
    );
  }

  test('resolvePlaybackStartOrdinal maps start hints to absolute ordinals in the whole-document plan', () => {
    const segments = wholeDocPlan();

    // By start page: first segment at/after the page.
    expect(resolvePlaybackStartOrdinal(
      segments,
      baseRequest({ documentSource: { namespace: null, extent: 'document', startPage: 2 } }),
    )).toBe(1);
    expect(resolvePlaybackStartOrdinal(
      segments,
      baseRequest({ documentSource: { namespace: null, extent: 'document', startPage: 3 } }),
    )).toBe(2);

    // By exact segment key (preferred, position-independent).
    const thirdKey = segments[2].segmentKey!;
    expect(resolvePlaybackStartOrdinal(segments, baseRequest({ startSegmentKey: thirdKey }))).toBe(2);

    // No hints → start at the document beginning.
    expect(resolvePlaybackStartOrdinal(segments, baseRequest({}))).toBe(0);
  });

  test('resolvePlaybackStartOrdinal uses EPUB spine coordinates before segment key/text hints', () => {
    const request = {
      ...baseRequest({
        startSegmentKey: 'client-whole-chapter-key-that-worker-will-not-match',
        startText: 'Repeated heading',
        documentSource: {
          namespace: null,
          extent: 'document',
          startSpineIndex: 1,
          startCharOffset: 500,
        },
      }),
      readerType: 'epub' as const,
    } as Parameters<typeof resolvePlaybackStartOrdinal>[1];
    const segments = [
      {
        segmentIndex: 0,
        segmentKey: 'title-page',
        text: 'Repeated heading',
        locator: { readerType: 'epub', spineHref: 'title.xhtml', spineIndex: 0, charOffset: 0 },
      },
      {
        segmentIndex: 1,
        segmentKey: 'chapter-one-early',
        text: 'Repeated heading',
        locator: { readerType: 'epub', spineHref: 'ch1.xhtml', spineIndex: 1, charOffset: 120 },
      },
      {
        segmentIndex: 2,
        segmentKey: 'chapter-one-target',
        text: 'Chapter one target.',
        locator: { readerType: 'epub', spineHref: 'ch1.xhtml', spineIndex: 1, charOffset: 520 },
      },
      {
        segmentIndex: 3,
        segmentKey: 'chapter-two',
        text: 'Chapter two.',
        locator: { readerType: 'epub', spineHref: 'ch2.xhtml', spineIndex: 2, charOffset: 0 },
      },
    ];

    expect(resolvePlaybackStartOrdinal(segments, request)).toBe(2);
  });

  test('plan signature ignores start position and voice/speed but varies with segmentation knobs', () => {
    const fromTop = computePlaybackPlanSignature(
      baseRequest({ maxBlockLength: 200, documentSource: { namespace: null, extent: 'document', startPage: 1 } }),
    );
    const fromMid = computePlaybackPlanSignature(
      baseRequest({ maxBlockLength: 200, documentSource: { namespace: null, extent: 'section', startPage: 9 } }),
    );
    expect(fromMid).toBe(fromTop); // start position must not fork the plan

    const differentVoice = {
      ...baseRequest({ maxBlockLength: 200, documentSource: { namespace: null, extent: 'document', startPage: 1 } }),
      settingsJson: { voice: 'echo', providerRef: 'p', providerType: 'openai', ttsModel: 'm', nativeSpeed: 2 },
    } as Parameters<typeof computePlaybackPlanSignature>[0];
    expect(computePlaybackPlanSignature(differentVoice)).toBe(fromTop); // voice/speed don't affect the plan

    const biggerBlocks = computePlaybackPlanSignature(
      baseRequest({ maxBlockLength: 400, documentSource: { namespace: null, extent: 'document', startPage: 1 } }),
    );
    expect(biggerBlocks).not.toBe(fromTop); // segmentation knobs do
  });
});

import { readFile } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import type { ArtifactStorage, ParsedPdfArtifactRevision, ParsedPdfArtifactStorage } from '../../src/infrastructure/storage';
import { createPdfLayoutHandler, type PdfLayoutExecution } from '../../src/jobs/pdf-layout';
import { computePlaybackPlanSignature, resolveAndPersistTtsPlaybackPlan } from '../../src/jobs/playback/plan';
import type { ParsedPdfDocument } from '../../src/operations/contracts';
import { parsedPdfArtifactKey } from '../../src/storage/artifact-addressing';

vi.mock('../../src/inference/pdf/model', () => ({ ensureModel: vi.fn() }));
vi.mock('../../src/inference/pdf/layout-model', () => ({
  runLayoutModel: async () => [{ label: 'text', bbox: [0, 0, 612, 792], confidence: 0.9 }],
}));
vi.mock('../../src/inference/pdf/render', () => ({
  renderPage: async () => ({ width: 612, height: 792, image: new Uint8Array(4) }),
}));

const PREFIX = 'test';
const DOCUMENT_ID = 'a'.repeat(64);
const LAYOUT_KEY = parsedPdfArtifactKey({ documentId: DOCUMENT_ID, namespace: null, prefix: PREFIX });

function memoryStorage() {
  const objects = new Map<string, Uint8Array>();
  const metadata = new Map<string, Record<string, string>>();
  let revision: ParsedPdfArtifactRevision | null = null;
  const storage: ParsedPdfArtifactStorage = {
    readObject: async (key) => {
      const body = objects.get(key);
      if (!body) throw Object.assign(new Error(`missing ${key}`), { name: 'NoSuchKey' });
      return Uint8Array.from(body).buffer;
    },
    objectExists: async (key) => objects.has(key),
    deleteObject: async (key) => { objects.delete(key); },
    listPrefix: async (prefix) => [...objects.keys()].filter((key) => key.startsWith(prefix)),
    listPrefixPages: async function* () { throw new Error('unused'); },
    listChildPrefixes: async () => { throw new Error('unused'); },
    putObject: async (key, body) => { objects.set(key, Uint8Array.from(body)); },
    putFile: async () => { throw new Error('unused'); },
    getParsedPdfRevision: async () => revision,
    putParsedPdf: async (_id, _namespace, parsed, options) => {
      expect(options.expected).toEqual(revision);
      objects.set(LAYOUT_KEY, Buffer.from(JSON.stringify(parsed)));
      metadata.set(LAYOUT_KEY, {
        'operation-id': options.operationId,
        ...(options.narrationRevision ? { 'narration-revision': options.narrationRevision } : {}),
      });
      revision = { etag: `etag-${options.operationId}`, operationId: options.operationId };
      return LAYOUT_KEY;
    },
  };
  return {
    storage,
    objects,
    metadata,
    layout: () => JSON.parse(Buffer.from(objects.get(LAYOUT_KEY)!).toString('utf8')) as ParsedPdfDocument,
    /** Stands in for a layout published by an earlier parser build. */
    seedLayout: (layout: ParsedPdfDocument) => {
      objects.set(LAYOUT_KEY, Buffer.from(JSON.stringify(layout)));
      metadata.set(LAYOUT_KEY, { 'operation-id': 'seed' });
      revision = { etag: 'etag-seed', operationId: 'seed' };
    },
  };
}

async function layoutRunner(memory: ReturnType<typeof memoryStorage>) {
  const bytes = await readFile(new URL('../../../../tests/files/cover-first.pdf', import.meta.url));
  memory.objects.set('test/source.pdf', Uint8Array.from(bytes));
  const run = createPdfLayoutHandler({
    storage: memory.storage, s3Prefix: PREFIX, pdfTimeoutMs: 5000, pdfHardCapMs: 10000, ttsPlaybackSegmentTimeoutMs: 5000,
  });
  let count = 0;
  /** Runs one layout job attempt; `assertActive` stands in for losing the job. */
  return (assertActive: PdfLayoutExecution['assertActive'] = async () => {}) => {
    count += 1;
    return run({ documentId: DOCUMENT_ID, namespace: null, documentObjectKey: 'test/source.pdf' }, 0, {
      opId: `op-${count}`,
      operationKey: `pdf_layout|v1|parser|${DOCUMENT_ID}||test/source.pdf|force-${count}`,
      attempt: 1,
      signal: new AbortController().signal,
      assertActive,
      onProgress: async () => {},
    });
  };
}

function withFirstBlockText(layout: ParsedPdfDocument, text: string): ParsedPdfDocument {
  const target = layout.pages.find((page) => page.blocks.length > 0)!;
  return {
    ...layout,
    pages: layout.pages.map((page) => (page !== target ? page : {
      ...page,
      blocks: page.blocks.map((block, index) => (index === 0 ? { ...block, text } : block)),
    })),
  };
}

describe('Force reparse layout narration revision', () => {
  test('a first parse and a reparse that narrates the same blocks publish no revision', async () => {
    const memory = memoryStorage();
    const parse = await layoutRunner(memory);
    await parse();
    const first = memory.layout();
    expect(first.pages.some((page) => page.blocks.length > 0)).toBe(true);
    expect(first).not.toHaveProperty('narrationRevision');

    // A reparse whose blocks differ only outside id, kind and text keeps the identity.
    memory.seedLayout({ ...first, parsedAt: 1, pages: first.pages.map((page) => ({ ...page, width: page.width + 1 })) });
    await parse();
    expect(memory.layout()).not.toHaveProperty('narrationRevision');
    expect(memory.metadata.get(LAYOUT_KEY)).not.toHaveProperty('narration-revision');
  });

  test('a reparse that changes narrated text gets a revision, kept until the text changes again', async () => {
    const memory = memoryStorage();
    const parse = await layoutRunner(memory);
    await parse();
    const fresh = memory.layout();

    // The saved layout came from an older parser that read the first block differently.
    memory.seedLayout(withFirstBlockText(fresh, 'Text from the older parser.'));
    await parse();
    const revision = memory.layout().narrationRevision;
    expect(revision).toMatch(/^[a-f0-9]{32}$/);
    expect(memory.metadata.get(LAYOUT_KEY)?.['narration-revision']).toBe(revision);
    expect(memory.layout().pages).toEqual(fresh.pages);

    // Repeating the reparse narrates the same blocks, so plans and audio stay valid.
    await parse();
    expect(memory.layout().narrationRevision).toBe(revision);
    expect(memory.metadata.get(LAYOUT_KEY)?.['narration-revision']).toBe(revision);

    // A changed layout never keeps the revision it replaces. The revision names
    // the narrated text, so returning to text seen before returns to its plans.
    const other = 'b'.repeat(32);
    memory.seedLayout({ ...withFirstBlockText(fresh, 'A different reading.'), narrationRevision: other });
    await parse();
    expect(memory.layout().narrationRevision).toBe(revision);
    expect(memory.layout().narrationRevision).not.toBe(other);
  });

  test('a reparse that fails before publishing leaves the previous layout and its revision', async () => {
    const memory = memoryStorage();
    const parse = await layoutRunner(memory);
    await parse();
    const saved = { ...withFirstBlockText(memory.layout(), 'Older text.'), narrationRevision: 'b'.repeat(32) };
    memory.seedLayout(saved);
    await expect(parse(async () => { throw new Error('operation cancelled'); })).rejects.toThrow('cancelled');
    expect(memory.layout()).toEqual(saved);
  });

  test('an attempt that loses the job while reading the previous layout does not publish', async () => {
    const memory = memoryStorage();
    const parse = await layoutRunner(memory);
    await parse();
    const saved = withFirstBlockText(memory.layout(), 'Older text.');
    memory.seedLayout(saved);
    let owner = true;
    const readObject = memory.storage.readObject;
    memory.storage.readObject = async (key, signal) => {
      const body = await readObject(key, signal);
      // A redelivered attempt takes over while this one reads the layout it replaces.
      if (key === LAYOUT_KEY) owner = false;
      return body;
    };
    await expect(parse(async () => { if (!owner) throw new Error('attempt superseded'); })).rejects.toThrow('superseded');
    expect(memory.layout()).toEqual(saved);
  });
});

const SETTINGS_JSON = { voice: 'alloy', providerRef: 'p', providerType: 'openai', ttsModel: 'm', nativeSpeed: 1 };

function planRequest(narrationRevision?: string) {
  return {
    sessionId: 'session-1',
    userId: 'user-1',
    storageUserId: 'user-1',
    documentId: DOCUMENT_ID,
    documentVersion: 1,
    readerType: 'pdf' as const,
    settingsHash: 'hash',
    settingsJson: SETTINGS_JSON,
    planning: {
      enforceSourceBoundaries: true,
      documentSource: {
        namespace: null,
        skipBlockKinds: [] as string[],
        extent: 'document' as const,
        ...(narrationRevision ? { narrationRevision } : {}),
      },
    },
  };
}

function pdfLayout(text: string, narrationRevision?: string): ParsedPdfDocument {
  return {
    schemaVersion: 1,
    documentId: DOCUMENT_ID,
    parserVersion: 'test',
    parsedAt: 0,
    ...(narrationRevision ? { narrationRevision } : {}),
    pages: [{
      pageNumber: 1,
      width: 100,
      height: 100,
      blocks: [{
        id: 'p1-b0',
        kind: 'table',
        text,
        fragments: [{ page: 1, bbox: [0, 0, 1, 1], text, readingOrder: 0 }],
      }],
    }],
  } as ParsedPdfDocument;
}

function planStorage(layout: ParsedPdfDocument) {
  const objects = new Map<string, Buffer>([[LAYOUT_KEY, Buffer.from(JSON.stringify(layout))]]);
  const failures = new Map<string, { error: Error; times: number }>();
  const storage = {
    readObject: async (key: string) => {
      const body = objects.get(key);
      const failure = failures.get(key);
      if (failure && failure.times > 0) { failure.times -= 1; throw failure.error; }
      if (!body) throw Object.assign(new Error(`missing ${key}`), { name: 'NoSuchKey' });
      return Uint8Array.from(body).buffer;
    },
    putObject: async (key: string, body: Buffer | Uint8Array) => { objects.set(key, Buffer.from(body)); },
  } as unknown as ArtifactStorage;
  return {
    storage,
    objects,
    /** The next `times` reads of `key` fail with `error`. */
    failNext: (key: string, error: Error, times = 1) => failures.set(key, { error, times }),
    replaceLayout: (next: ParsedPdfDocument) => objects.set(LAYOUT_KEY, Buffer.from(JSON.stringify(next))),
  };
}

const plan = (memory: ReturnType<typeof planStorage>, request: ReturnType<typeof planRequest> & { planObjectKey?: string }) =>
  resolveAndPersistTtsPlaybackPlan({ request, storage: memory.storage, s3Prefix: PREFIX });

const unavailable = () => Object.assign(new Error('Service Unavailable'), { $metadata: { httpStatusCode: 503 } });

describe('Force reparse plan identity', () => {
  test('a layout without a revision keeps the existing plan signature', () => {
    // Pinned on upstream 78390594 so existing plans and their keys stay valid.
    expect(computePlaybackPlanSignature(planRequest())).toBe('0e282a92d81f80909f5b357af56f0e1a');
  });

  test('a reparsed layout with changed narration gets its own plan', async () => {
    const memory = planStorage(pdfLayout('Old table text.'));
    const before = await plan(memory, planRequest());
    expect(before.plannedSegments.map((segment) => segment.text)).toEqual(['Old table text.']);

    const revision = 'c'.repeat(32);
    memory.replaceLayout(pdfLayout('Spruce log 41 cm.', revision));
    const after = await plan(memory, planRequest(revision));
    expect(after.planSignature).not.toBe(before.planSignature);
    expect(after.planObjectKey).not.toBe(before.planObjectKey);
    expect(after.plannedSegments.map((segment) => segment.text)).toEqual(['Spruce log 41 cm.']);
    expect(JSON.parse(memory.objects.get(after.planObjectKey)!.toString('utf8'))).toMatchObject({ narrationRevision: revision });

    // An open reader or a pinned export keeps the plan it already has.
    const pinned = await plan(memory, { ...planRequest(), planObjectKey: before.planObjectKey });
    expect(pinned.plannedSegments.map((segment) => segment.text)).toEqual(['Old table text.']);
    expect(JSON.parse(memory.objects.get(before.planObjectKey)!.toString('utf8'))).not.toHaveProperty('narrationRevision');
  });

  test('planning refuses a layout whose revision does not match the request', async () => {
    const memory = planStorage(pdfLayout('Newer text.', 'd'.repeat(32)));
    await expect(plan(memory, planRequest())).rejects.toMatchObject({ code: 'PDF_LAYOUT_CHANGED', retryable: false });
    await expect(plan(memory, planRequest('e'.repeat(32)))).rejects.toMatchObject({ code: 'PDF_LAYOUT_CHANGED' });
    expect([...memory.objects.keys()]).toEqual([LAYOUT_KEY]);
  });

  test('a cleared plan is planned again only under its own key', async () => {
    const first = 'c'.repeat(32);
    const memory = planStorage(pdfLayout('First replacement.', first));
    const planned = await plan(memory, planRequest(first));
    memory.objects.delete(planned.planObjectKey);

    // The layout changed again before an audiobook requested on the first
    // revision asked for its cleared plan: the worker confirms the change.
    const second = 'd'.repeat(32);
    memory.replaceLayout(pdfLayout('Second replacement.', second));
    await expect(plan(memory, { ...planRequest(first), planObjectKey: planned.planObjectKey }))
      .rejects.toMatchObject({ code: 'PDF_LAYOUT_CHANGED' });
    // A reader that only knows the current revision is asked to reopen instead,
    // and nothing is written under the old key either way.
    const reopen = plan(memory, { ...planRequest(second), planObjectKey: planned.planObjectKey });
    await expect(reopen).rejects.toThrow('Reopen the document');
    await expect(reopen).rejects.not.toHaveProperty('code', 'PDF_LAYOUT_CHANGED');
    expect(memory.objects.has(planned.planObjectKey)).toBe(false);

    // Its own revision can still rebuild it under the same key.
    memory.replaceLayout(pdfLayout('First replacement.', first));
    const rebuilt = await plan(memory, { ...planRequest(first), planObjectKey: planned.planObjectKey });
    expect(rebuilt.plannedSegments.map((segment) => segment.text)).toEqual(['First replacement.']);
  });

  test('a saved plan that a read fails to return is recovered as stored, never reported as a replaced layout', async () => {
    const memory = planStorage(pdfLayout('Original text.'));
    const planned = await plan(memory, planRequest());
    const stored = memory.objects.get(planned.planObjectKey)!;
    memory.replaceLayout(pdfLayout('Newer text.', 'd'.repeat(32)));
    // One failed read: the plan is read again before any verdict, found, and not rewritten.
    memory.failNext(planned.planObjectKey, unavailable());
    const recovered = await plan(memory, { ...planRequest(), planObjectKey: planned.planObjectKey });
    expect(recovered.plannedSegments.map((segment) => segment.text)).toEqual(['Original text.']);
    expect(memory.objects.get(planned.planObjectKey)).toBe(stored);
    // Storage that keeps failing raises its own error, which can be retried.
    memory.failNext(planned.planObjectKey, unavailable(), 2);
    await expect(plan(memory, { ...planRequest(), planObjectKey: planned.planObjectKey })).rejects.toThrow('Service Unavailable');
  });

  test('a cleared saved key on a layout without a revision is planned again as on upstream', async () => {
    const memory = planStorage(pdfLayout('Table text.'));
    const planned = await plan(memory, planRequest());
    memory.objects.delete(planned.planObjectKey);
    // No reparse changed this PDF, so no revision can be behind the key.
    const skipping = planRequest();
    skipping.planning.documentSource.skipBlockKinds = ['header'];
    const replanned = await plan(memory, { ...skipping, planObjectKey: planned.planObjectKey });
    expect(replanned.planObjectKey).toBe(planned.planObjectKey);
    expect(replanned.plannedSegments.map((segment) => segment.text)).toEqual(['Table text.']);
  });

  test('a stored plan of another layout revision is never used for a request', async () => {
    const memory = planStorage(pdfLayout('Original text.'));
    const planned = await plan(memory, planRequest());
    const revision = 'd'.repeat(32);
    memory.replaceLayout(pdfLayout('Newer text.', revision));
    // The app resolved the newer revision while the key was briefly missing,
    // and the earlier plan was published again before the worker read it.
    await expect(plan(memory, { ...planRequest(revision), planObjectKey: planned.planObjectKey }))
      .rejects.toThrow('another version of this PDF layout');
    memory.failNext(planned.planObjectKey, unavailable());
    await expect(plan(memory, { ...planRequest(revision), planObjectKey: planned.planObjectKey }))
      .rejects.toThrow('another version of this PDF layout');
    // The request for the plan's own revision still uses it.
    const pinned = await plan(memory, { ...planRequest(), planObjectKey: planned.planObjectKey });
    expect(pinned.plannedSegments.map((segment) => segment.text)).toEqual(['Original text.']);
  });

  test('a PDF request without a document source reads its saved plan as stored', async () => {
    const revision = 'd'.repeat(32);
    const memory = planStorage(pdfLayout('Reparsed text.', revision));
    const planned = await plan(memory, planRequest(revision));
    const planning: Partial<ReturnType<typeof planRequest>['planning']> = { ...planRequest(revision).planning };
    delete planning.documentSource;
    const bare = { ...planRequest(revision), planning, planObjectKey: planned.planObjectKey };
    const read = await plan(memory, bare as never);
    expect(read.plannedSegments.map((segment) => segment.text)).toEqual(['Reparsed text.']);
  });
});

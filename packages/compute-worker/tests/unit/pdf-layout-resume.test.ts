import { readFile } from 'node:fs/promises';
import { expect, test, vi } from 'vitest';
import { createPdfLayoutHandler, type PdfLayoutExecution } from '../../src/jobs/pdf-layout';
import type { ParsedPdfArtifactRevision, ParsedPdfArtifactStorage } from '../../src/infrastructure/storage';
import { parsedPdfArtifactKey } from '../../src/storage/artifact-addressing';

vi.mock('../../src/inference/pdf/model', () => ({ ensureModel: vi.fn() }));
vi.mock('../../src/inference/pdf/layout-model', () => ({
  runLayoutModel: async () => [{ label: 'text', bbox: [0, 0, 612, 792], confidence: 0.9 }],
}));
vi.mock('../../src/inference/pdf/render', () => ({
  renderPage: async () => ({ width: 612, height: 792, image: new Uint8Array(4) }),
}));

test('an interrupted PDF resumes from saved pages and recovers an already-published artifact', async () => {
  const bytes = await readFile(new URL('../../../../tests/files/cover-first.pdf', import.meta.url));
  const source = Uint8Array.from(bytes);
  const documentId = 'a'.repeat(64);
  const payload = { documentId, namespace: null, documentObjectKey: 'test/source.pdf' };
  const artifactKey = parsedPdfArtifactKey({ ...payload, prefix: 'test' });
  const objects = new Map<string, Uint8Array>([[payload.documentObjectKey, source]]);
  let revision: ParsedPdfArtifactRevision | null = null;
  const putParsedPdf = vi.fn<ParsedPdfArtifactStorage['putParsedPdf']>(async (_id, _namespace, parsed, options) => {
    expect(options.expected).toEqual(revision);
    objects.set(artifactKey, Buffer.from(JSON.stringify(parsed)));
    revision = { etag: 'etag', operationId: options.operationId };
    return artifactKey;
  });
  const storage: ParsedPdfArtifactStorage = {
    readObject: vi.fn(async (key) => Uint8Array.from(objects.get(key)!).buffer),
    objectExists: async (key) => objects.has(key),
    deleteObject: async (key) => { objects.delete(key); },
    listPrefix: async (prefix) => [...objects.keys()].filter((key) => key.startsWith(prefix)),
    listPrefixPages: async function* () { throw new Error('unused'); },
    listChildPrefixes: async () => { throw new Error('unused'); },
    putObject: async (key, body) => { objects.set(key, body); },
    putFile: async () => { throw new Error('unused'); },
    getParsedPdfRevision: async () => revision,
    putParsedPdf,
  };
  const run = createPdfLayoutHandler({
    storage, s3Prefix: 'test', pdfTimeoutMs: 5000, pdfHardCapMs: 10000, ttsPlaybackSegmentTimeoutMs: 5000,
  });
  const execution: PdfLayoutExecution = {
    opId: 'op', operationKey: 'pdf-op-key', attempt: 1, signal: new AbortController().signal,
    assertActive: async () => {},
    onProgress: async (progress) => {
      if (progress.phase === 'merge') throw new Error('interrupted');
    },
  };

  await expect(run(payload, 0, execution)).rejects.toThrow('interrupted');
  const checkpointKey = [...objects.keys()].find((key) => key.includes('/checkpoint/'));
  expect(checkpointKey).toBeDefined();
  expect(putParsedPdf).not.toHaveBeenCalled();

  const onProgress = vi.fn(async () => {});
  await expect(run(payload, 0, { ...execution, attempt: 2, onProgress })).resolves.toMatchObject({
    parsedObjectKey: artifactKey,
  });
  expect(onProgress.mock.calls).toEqual([[expect.objectContaining({ phase: 'merge', pagesParsed: 3 })]]);
  expect(putParsedPdf).toHaveBeenCalledOnce();
  expect(objects.has(checkpointKey!)).toBe(false);

  onProgress.mockClear();
  await expect(run(payload, 0, { ...execution, attempt: 3, onProgress })).resolves.toMatchObject({
    parsedObjectKey: artifactKey,
  });
  expect(onProgress).not.toHaveBeenCalled();
  expect(putParsedPdf).toHaveBeenCalledOnce();
});

import { expect, test, vi } from 'vitest';
import type { ArtifactStorage } from '../../src/infrastructure/storage';
import { createDocumentPreviewHandler } from '../../src/jobs/document-preview';
import { buildDocumentPreviewOperationKey } from '../../src/operations/keys';
import { documentPreviewArtifactKey } from '../../src/storage/artifact-addressing';

vi.mock('../../src/jobs/document-preview-render', () => ({
  renderPdfFirstPageToJpeg: async (_bytes: Buffer, width: number) => ({ width, height: 500, bytes: Buffer.from('new image') }),
}));

test('adopts a matching preview after a final-delivery conflict and keeps sizes distinct', async () => {
  const request = {
    documentId: 'a'.repeat(64), namespace: null, documentType: 'pdf' as const,
    sourceObjectKey: 'test/source.pdf', previewKind: 'card' as const, sourceLastModifiedMs: 1,
  };
  const objects = new Map<string, { etag: string; metadata: Record<string, string>; size: number }>();
  const putObject = vi.fn<ArtifactStorage['putObject']>(async (key, body, _type, _signal, _expected, metadata) => {
    objects.set(key, { etag: 'older-delivery', metadata: metadata ?? {}, size: body.byteLength });
    throw Object.assign(new Error('already published'), { name: 'PreconditionFailed' });
  });
  const storage = {
    headObject: async (key: string) => objects.get(key) ?? null,
    getObjectEtag: async () => null,
    readObject: async () => new ArrayBuffer(0),
    putObject,
  } as unknown as ArtifactStorage;
  const run = createDocumentPreviewHandler({
    storage, s3Prefix: 'test', pdfTimeoutMs: 5_000, pdfHardCapMs: 10_000, ttsPlaybackSegmentTimeoutMs: 5_000,
  });
  const defaultKey = documentPreviewArtifactKey({ ...request, prefix: 'test' });
  const wide = { ...request, targetWidth: 800 };
  const wideKey = documentPreviewArtifactKey({ ...wide, prefix: 'test' });
  expect(buildDocumentPreviewOperationKey(wide)).not.toBe(buildDocumentPreviewOperationKey(request));
  expect(wideKey).not.toBe(defaultKey);

  const execution = { opId: 'preview', operationKey: buildDocumentPreviewOperationKey(wide),
    attempt: 3, signal: new AbortController().signal, assertActive: async () => undefined };
  await expect(run(wide, 0, execution)).resolves.toMatchObject({
    artifact: { width: 800, objectKey: wideKey, eTag: 'older-delivery' },
  });
  expect(putObject.mock.calls[0]?.[4]).toBeNull();
  expect(await run(wide, 0, execution)).toMatchObject({ artifact: { width: 800 }, timing: { computeMs: 0 } });
  expect(putObject).toHaveBeenCalledOnce();
});

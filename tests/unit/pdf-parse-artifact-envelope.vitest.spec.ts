import { beforeEach, describe, expect, test, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  getParsedDocumentBlobByKey: vi.fn(),
  resolveCurrentPdfParse: vi.fn(),
}));

vi.mock('@/lib/server/documents/blobstore', () => ({
  getParsedDocumentBlobByKey: hoisted.getParsedDocumentBlobByKey,
  isMissingBlobError: vi.fn(() => false),
}));

vi.mock('@/lib/server/pdf-parse/operation', () => ({
  resolveCurrentPdfParse: hoisted.resolveCurrentPdfParse,
}));

describe('parsed PDF artifact envelope validation', () => {
  beforeEach(() => {
    hoisted.resolveCurrentPdfParse.mockReset();
    hoisted.resolveCurrentPdfParse.mockResolvedValue({
      artifact: { objectKey: 'openreader/parsed.json' },
      operation: null,
    });
    hoisted.getParsedDocumentBlobByKey.mockReset();
  });

  test('accepts a valid current artifact envelope', async () => {
    hoisted.getParsedDocumentBlobByKey.mockResolvedValue(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      documentId: 'doc-1',
      parserVersion: 'parser-v1',
      parsedAt: 1,
      pages: [{ pageNumber: 1, width: 100, height: 200, blocks: [] }],
    })));

    const { readCurrentParsedPdfArtifact } = await import('../../src/lib/server/pdf-parse/artifact');
    await expect(readCurrentParsedPdfArtifact({ documentId: 'doc-1', namespace: null }))
      .resolves.toMatchObject({ key: 'openreader/parsed.json' });
  });

  test('rejects malformed envelopes and document identity mismatches', async () => {
    const { readCurrentParsedPdfArtifact } = await import('../../src/lib/server/pdf-parse/artifact');

    hoisted.getParsedDocumentBlobByKey.mockResolvedValueOnce(Buffer.from(JSON.stringify({
      schemaVersion: 2,
      documentId: 'doc-1',
      pages: [],
    })));
    await expect(readCurrentParsedPdfArtifact({ documentId: 'doc-1', namespace: null }))
      .rejects.toThrow('envelope is invalid');

    hoisted.getParsedDocumentBlobByKey.mockResolvedValueOnce(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      documentId: 'other-doc',
      parserVersion: 'parser-v1',
      parsedAt: 1,
      pages: [],
    })));
    await expect(readCurrentParsedPdfArtifact({ documentId: 'doc-1', namespace: null }))
      .rejects.toThrow('document identity mismatch');

    hoisted.getParsedDocumentBlobByKey.mockResolvedValueOnce(Buffer.from(JSON.stringify({
      schemaVersion: 1,
      documentId: 'doc-1',
      parserVersion: 'parser-v1',
      parsedAt: 1,
      pages: [{ pageNumber: 1, width: 100, height: 200 }],
    })));
    await expect(readCurrentParsedPdfArtifact({ documentId: 'doc-1', namespace: null }))
      .rejects.toThrow('envelope is invalid');
  });
});

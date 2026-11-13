import { describe, expect, test } from 'vitest';
import type { ParsedPdfPage } from '../../src/api/types';
import { PDF_PARSER_VERSION } from '../../src/operations/contracts';
import { parsedPdfArtifactPrefix } from '../../src/storage/artifact-addressing';
import {
  clearPdfParseCheckpoint,
  pdfParseCheckpointChunkKey,
  readPdfParseCheckpoint,
  writePdfParseCheckpointChunk,
} from '../../src/storage/pdf-parse-checkpoint';
import { MemoryArtifactStorage } from '../fixtures/memory-storage';

const documentId = 'c'.repeat(64);
const scope = {
  documentId,
  namespace: null,
  prefix: 'openreader-test',
  sourceObjectKey: `openreader-test/documents_v1/${documentId}`,
};

function page(pageNumber: number): ParsedPdfPage {
  return {
    pageNumber,
    width: 600,
    height: 800,
    blocks: [{
      id: `b${String(pageNumber).padStart(4, '0')}`,
      kind: 'text',
      text: `page ${pageNumber}`,
      fragments: [{
        page: pageNumber,
        bbox: [0, 0, 10, 10],
        text: `page ${pageNumber}`,
        readingOrder: 0,
      }],
    }],
  } as ParsedPdfPage;
}

async function writeChunk(storage: MemoryArtifactStorage, startPage: number, count: number): Promise<void> {
  await writePdfParseCheckpointChunk({
    ...scope,
    storage,
    totalPages: 30,
    startPage,
    sawText: true,
    pages: Array.from({ length: count }, (_, index) => page(startPage + index)),
  });
}

describe('PDF parse checkpoints', () => {
  test('keeps checkpoints under the parsed prefix the document cleanup already walks', () => {
    expect(pdfParseCheckpointChunkKey({ ...scope, startPage: 9 }))
      .toBe(`${parsedPdfArtifactPrefix(scope)}checkpoint/${encodeURIComponent(PDF_PARSER_VERSION)}/000009.json`);
  });

  test('resumes from whole chunks and stops at the first gap', async () => {
    const storage = new MemoryArtifactStorage();
    await writeChunk(storage, 1, 8);
    await writeChunk(storage, 9, 8);
    // Page 17 to 24 never landed, so pages after the gap cannot be trusted.
    await writeChunk(storage, 25, 8);

    const resume = await readPdfParseCheckpoint({ ...scope, storage });
    expect(resume?.pages.map((value) => value.pageNumber)).toEqual(
      Array.from({ length: 16 }, (_, index) => index + 1),
    );
  });

  test('ignores a checkpoint written for different source bytes', async () => {
    const storage = new MemoryArtifactStorage();
    await writeChunk(storage, 1, 8);

    await expect(readPdfParseCheckpoint({
      ...scope,
      storage,
      sourceObjectKey: `${scope.sourceObjectKey}-replaced`,
    })).resolves.toBeNull();
  });

  test('ignores a checkpoint left by another parser version', async () => {
    const storage = new MemoryArtifactStorage();
    await writeChunk(storage, 1, 8);

    await expect(readPdfParseCheckpoint({
      ...scope,
      storage,
      parserVersion: 'pp-something-newer@1',
    })).resolves.toBeNull();
  });

  test('survives an unreadable chunk by resuming from what came before it', async () => {
    const storage = new MemoryArtifactStorage();
    await writeChunk(storage, 1, 8);
    storage.objects.set(
      pdfParseCheckpointChunkKey({ ...scope, startPage: 9 }),
      Buffer.from('{ truncated', 'utf8'),
    );

    const resume = await readPdfParseCheckpoint({ ...scope, storage });
    expect(resume?.pages).toHaveLength(8);
  });

  test('reports no resumable work before anything is checkpointed, and after it is cleared', async () => {
    const storage = new MemoryArtifactStorage();
    await expect(readPdfParseCheckpoint({ ...scope, storage })).resolves.toBeNull();

    await writeChunk(storage, 1, 8);
    await expect(clearPdfParseCheckpoint({ ...scope, storage })).resolves.toBe(1);
    await expect(readPdfParseCheckpoint({ ...scope, storage })).resolves.toBeNull();
    expect(storage.objects.size).toBe(0);
  });
});

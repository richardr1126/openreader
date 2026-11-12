import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ParsedPdfPage } from '../../src/api/types';
import { MemoryArtifactStorage } from '../fixtures/memory-storage';

const runPdfLayoutFromPdfBuffer = vi.hoisted(() => vi.fn());
vi.mock('../../src/inference/runtime', () => ({ runPdfLayoutFromPdfBuffer }));

const { createPdfLayoutHandler } = await import('../../src/jobs/pdf-layout');
const {
  pdfParseCheckpointPrefix,
  readPdfParseCheckpoint,
  writePdfParseCheckpointChunk,
} = await import('../../src/storage/pdf-parse-checkpoint');

const documentId = 'd'.repeat(64);
const s3Prefix = 'openreader-test';
const documentObjectKey = `${s3Prefix}/documents_v1/${documentId}`;
const payload = { documentId, namespace: null, documentObjectKey };

function page(pageNumber: number): ParsedPdfPage {
  return { pageNumber, width: 600, height: 800, blocks: [] } as ParsedPdfPage;
}

function handlerFor(storage: MemoryArtifactStorage) {
  return createPdfLayoutHandler({
    storage,
    pdfTimeoutMs: 300_000,
    pdfHardCapMs: 600_000,
    ttsPlaybackSegmentTimeoutMs: 30_000,
    s3Prefix,
  });
}

function storageWithSource(): MemoryArtifactStorage {
  const storage = new MemoryArtifactStorage();
  storage.objects.set(documentObjectKey, Buffer.from('%PDF-1.4', 'utf8'));
  storage.putParsedPdf = async () => `${s3Prefix}/documents_v1/parsed_v2/${documentId}/parser.json`;
  return storage;
}

describe('PDF layout job checkpoints', () => {
  beforeEach(() => {
    runPdfLayoutFromPdfBuffer.mockReset();
  });

  test('hands an interrupted run its completed pages and makes new ones durable', async () => {
    const storage = storageWithSource();
    await writePdfParseCheckpointChunk({
      storage,
      documentId,
      namespace: null,
      prefix: s3Prefix,
      sourceObjectKey: documentObjectKey,
      totalPages: 20,
      startPage: 1,
      sawText: true,
      pages: [page(1), page(2), page(3)],
    });

    runPdfLayoutFromPdfBuffer.mockImplementation(async (input) => {
      // Whatever an earlier run finished is offered back before any parsing.
      expect(input.resume).toMatchObject({ sawText: true });
      expect(input.resume.pages).toHaveLength(3);
      await input.onPagesCompleted({
        pages: [page(4), page(5)], startPage: 4, totalPages: 20, sawText: true,
      });
      return { parsed: { pages: [] } };
    });

    const result = await handlerFor(storage)(payload, 0);

    expect(result.parsedObjectKey).toContain('parsed_v2');
    expect(runPdfLayoutFromPdfBuffer).toHaveBeenCalledOnce();
  });

  test('drops the checkpoint once the parsed artifact is durable', async () => {
    const storage = storageWithSource();
    runPdfLayoutFromPdfBuffer.mockImplementation(async (input) => {
      await input.onPagesCompleted({
        pages: [page(1), page(2)], startPage: 1, totalPages: 2, sawText: true,
      });
      return { parsed: { pages: [] } };
    });

    await handlerFor(storage)(payload, 0);

    expect(await storage.listPrefix(pdfParseCheckpointPrefix({
      documentId, namespace: null, prefix: s3Prefix,
    }))).toEqual([]);
  });

  test('keeps the checkpoint when the parse fails, so the next run resumes', async () => {
    const storage = storageWithSource();
    runPdfLayoutFromPdfBuffer.mockImplementation(async (input) => {
      await input.onPagesCompleted({
        pages: [page(1), page(2)], startPage: 1, totalPages: 40, sawText: true,
      });
      throw new Error('worker stopped');
    });

    await expect(handlerFor(storage)(payload, 0)).rejects.toThrow('worker stopped');

    await expect(readPdfParseCheckpoint({
      storage, documentId, namespace: null, prefix: s3Prefix, sourceObjectKey: documentObjectKey,
    })).resolves.toMatchObject({ sawText: true });
  });

  test('parses from the first page when a checkpoint cannot be read', async () => {
    const storage = storageWithSource();
    storage.listPrefix = async () => { throw new Error('object store unavailable'); };
    runPdfLayoutFromPdfBuffer.mockImplementation(async (input) => {
      expect(input.resume).toBeNull();
      return { parsed: { pages: [] } };
    });

    await expect(handlerFor(storage)(payload, 0)).resolves.toMatchObject({
      parsedObjectKey: expect.any(String),
    });
  });
});

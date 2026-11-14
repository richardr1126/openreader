import type { ParsedPdfPage } from '../api/types';
import type { ArtifactStorage } from '../infrastructure/storage';
import { PDF_PARSER_VERSION, encodeParserVersion } from '../operations/contracts';
import { parsedPdfArtifactPrefix } from './artifact-addressing';
import { deletePrefix } from './prefix-cleanup';

/**
 * Parsing a long PDF costs minutes of layout inference, and until this the only
 * durable output was the finished artifact: a worker that stopped at page 400
 * of 506 left nothing behind and the next run started at page 1 again.
 *
 * Completed pages are written here in chunks as parsing proceeds, so a later run
 * resumes from the last whole chunk. Chunks live under the parsed-PDF prefix on
 * purpose: deleting a document, clearing its layout cache and accounting for its
 * storage all walk that prefix already, so a checkpoint cannot outlive what it
 * belongs to.
 */
export interface PdfParseCheckpointChunk {
  schemaVersion: 1;
  documentId: string;
  parserVersion: string;
  sourceObjectKey: string;
  totalPages: number;
  startPage: number;
  /** Whether any page up to the end of this chunk carried a text layer. */
  sawText: boolean;
  pages: ParsedPdfPage[];
}

export interface PdfParseCheckpoint {
  pages: ParsedPdfPage[];
  sawText: boolean;
}

type CheckpointScope = {
  documentId: string;
  namespace: string | null;
  prefix: string;
  parserVersion?: string;
};

export function pdfParseCheckpointPrefix(input: CheckpointScope): string {
  const version = encodeParserVersion(input.parserVersion ?? PDF_PARSER_VERSION);
  return `${parsedPdfArtifactPrefix(input)}checkpoint/${version}/`;
}

/** Chunks sort by key in page order, so a listing needs no further ordering. */
export function pdfParseCheckpointChunkKey(input: CheckpointScope & { startPage: number }): string {
  const startPage = Math.max(1, Math.floor(input.startPage));
  return `${pdfParseCheckpointPrefix(input)}${String(startPage).padStart(6, '0')}.json`;
}

function readChunk(value: unknown, expected: {
  documentId: string;
  sourceObjectKey: string;
  parserVersion: string;
}): PdfParseCheckpointChunk | null {
  if (!value || typeof value !== 'object') return null;
  const chunk = value as Partial<PdfParseCheckpointChunk>;
  if (chunk.schemaVersion !== 1) return null;
  if (chunk.documentId !== expected.documentId) return null;
  if (chunk.sourceObjectKey !== expected.sourceObjectKey) return null;
  if (chunk.parserVersion !== expected.parserVersion) return null;
  if (!Array.isArray(chunk.pages) || chunk.pages.length === 0) return null;
  if (!Number.isInteger(chunk.startPage) || (chunk.startPage ?? 0) < 1) return null;
  return chunk as PdfParseCheckpointChunk;
}

/**
 * The pages a new run can start from: the longest run of chunks that covers
 * pages 1..n with no gap. A chunk that is missing, unreadable or written for
 * different source bytes ends the run, because parsing must not resume onto
 * pages that were never parsed or belong to another document.
 */
export async function readPdfParseCheckpoint(input: CheckpointScope & {
  storage: ArtifactStorage;
  sourceObjectKey: string;
}): Promise<PdfParseCheckpoint | null> {
  const parserVersion = input.parserVersion ?? PDF_PARSER_VERSION;
  const keys = await input.storage.listPrefix(pdfParseCheckpointPrefix(input));
  if (keys.length === 0) return null;

  const pages: ParsedPdfPage[] = [];
  let sawText = false;
  for (const key of [...keys].sort()) {
    const chunk = await input.storage.readObject(key)
      .then((bytes) => readChunk(JSON.parse(Buffer.from(bytes).toString('utf8')), {
        documentId: input.documentId,
        sourceObjectKey: input.sourceObjectKey,
        parserVersion,
      }))
      .catch(() => null);
    if (!chunk || chunk.startPage !== pages.length + 1) break;
    pages.push(...chunk.pages);
    sawText = sawText || chunk.sawText;
  }
  return pages.length > 0 ? { pages, sawText } : null;
}

export async function writePdfParseCheckpointChunk(input: CheckpointScope & {
  storage: ArtifactStorage;
  sourceObjectKey: string;
  totalPages: number;
  startPage: number;
  sawText: boolean;
  pages: ParsedPdfPage[];
}): Promise<void> {
  const chunk: PdfParseCheckpointChunk = {
    schemaVersion: 1,
    documentId: input.documentId,
    parserVersion: input.parserVersion ?? PDF_PARSER_VERSION,
    sourceObjectKey: input.sourceObjectKey,
    totalPages: input.totalPages,
    startPage: input.startPage,
    sawText: input.sawText,
    pages: input.pages,
  };
  await input.storage.putObject(
    pdfParseCheckpointChunkKey(input),
    Buffer.from(JSON.stringify(chunk), 'utf8'),
    'application/json',
  );
}

export function clearPdfParseCheckpoint(input: CheckpointScope & {
  storage: ArtifactStorage;
}): Promise<number> {
  return deletePrefix(input.storage, pdfParseCheckpointPrefix(input));
}

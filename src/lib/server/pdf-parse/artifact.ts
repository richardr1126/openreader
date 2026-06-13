import {
  getParsedDocumentBlobByKey,
  isMissingBlobError,
} from '@/lib/server/documents/blobstore';
import { resolveCurrentPdfParse } from '@/lib/server/pdf-parse/operation';
import type { ParsedPdfDocument } from '@/types/parsed-pdf';

export interface ParsedPdfArtifact {
  key: string;
  bytes: Buffer;
  parsed: ParsedPdfDocument;
}

function parseArtifact(bytes: Buffer): ParsedPdfDocument {
  const parsed = JSON.parse(bytes.toString('utf8')) as Partial<ParsedPdfDocument>;
  if (
    parsed.schemaVersion !== 1
    || typeof parsed.documentId !== 'string'
    || typeof parsed.parserVersion !== 'string'
    || typeof parsed.parsedAt !== 'number'
    || !Array.isArray(parsed.pages)
    || parsed.pages.some((page) => (
      !page
      || typeof page !== 'object'
      || typeof page.pageNumber !== 'number'
      || typeof page.width !== 'number'
      || typeof page.height !== 'number'
      || !Array.isArray(page.blocks)
    ))
  ) {
    throw new Error('Parsed PDF artifact envelope is invalid');
  }
  return parsed as ParsedPdfDocument;
}

export async function readParsedPdfArtifactByKey(key: string): Promise<ParsedPdfArtifact | null> {
  try {
    const bytes = await getParsedDocumentBlobByKey(key);
    return {
      key,
      bytes,
      parsed: parseArtifact(bytes),
    };
  } catch (error) {
    if (isMissingBlobError(error)) return null;
    throw error;
  }
}

export async function readCurrentParsedPdfArtifact(input: {
  documentId: string;
  namespace: string | null;
}): Promise<ParsedPdfArtifact | null> {
  const resolved = await resolveCurrentPdfParse(input);
  if (!resolved.artifact) return null;
  const artifact = await readParsedPdfArtifactByKey(resolved.artifact.objectKey);
  if (artifact && artifact.parsed.documentId !== input.documentId) {
    throw new Error('Parsed PDF artifact document identity mismatch');
  }
  return artifact;
}

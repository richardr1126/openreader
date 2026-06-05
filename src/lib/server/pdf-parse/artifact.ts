import { PDF_PARSER_VERSION } from '@openreader/compute-core/api-contracts';
import {
  documentParsedKeyForVersion,
  getParsedDocumentBlobByKey,
  isMissingBlobError,
} from '@/lib/server/documents/blobstore';
import type { ParsedPdfDocument } from '@/types/parsed-pdf';

export interface ParsedPdfArtifact {
  key: string;
  bytes: Buffer;
  parsed: ParsedPdfDocument;
}

function parseArtifact(bytes: Buffer): ParsedPdfDocument {
  return JSON.parse(bytes.toString('utf8')) as ParsedPdfDocument;
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
  const key = documentParsedKeyForVersion(input.documentId, input.namespace, PDF_PARSER_VERSION);
  return readParsedPdfArtifactByKey(key);
}

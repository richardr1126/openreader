import type { BaseDocument } from '../../../../../../src/types/documents';
import type { ParsedPdfBlock, ParsedPdfBlockKind, ParsedPdfDocument, ParsedPdfPage } from '../../../../src/api/types';

export function makeBaseDocument(overrides: Partial<BaseDocument> = {}): BaseDocument {
  return {
    id: 'doc-1',
    name: 'document.pdf',
    size: 1_024,
    lastModified: 1_700_000_000_000,
    type: 'pdf',
    ...overrides,
  };
}

export function makeParsedPdfBlock(input: {
  id: string;
  kind: ParsedPdfBlockKind;
  text: string;
  page: number;
  readingOrder: number;
}): ParsedPdfBlock {
  return {
    id: input.id,
    kind: input.kind,
    text: input.text,
    fragments: [
      {
        page: input.page,
        bbox: [0, 0, 100, 10],
        text: input.text,
        readingOrder: input.readingOrder,
      },
    ],
  };
}

export function makeParsedPdfPage(pageNumber: number, blocks: ParsedPdfBlock[]): ParsedPdfPage {
  return {
    pageNumber,
    width: 800,
    height: 1_200,
    blocks,
  };
}

export function makeParsedPdfDocument(pages: ParsedPdfPage[]): ParsedPdfDocument {
  return {
    schemaVersion: 1,
    documentId: 'doc-fixture',
    parserVersion: 'test',
    parsedAt: 1_700_000_000_000,
    pages,
  };
}
